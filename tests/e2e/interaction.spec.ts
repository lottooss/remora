import { describe, expect, it, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  PendingRegistry,
  RcpServer,
  createHostIdentity,
  enrollHost,
  raceApproval,
  raceQuestion,
  registerInteractionMethods,
} from '@remora/host'
import {
  buildCanonicalApprovalMessage,
  computeArgsDigest,
  encodeBase64Url,
  generateApprovalKeypair,
  signApprovalMessage,
  utf8ToBytes,
} from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('End-to-End Interaction & AnswerBridge (P3-H1)', () => {
  let env: E2eEnvironment | null = null
  let hostRelay: HostRelayConnection | null = null
  let device: FakeDevice | null = null

  afterEach(async () => {
    if (device) {
      await device.disconnect()
      device = null
    }
    if (hostRelay) {
      await hostRelay.stop()
      hostRelay = null
    }
    if (env) {
      await env.teardown()
      env = null
    }
  })

  it('runs complete interaction e2e: approval wait, phone-first answer, single-use check, and question answering', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Interaction-Host')

    const registry = new InMemoryDeviceRegistry()
    const pendingRegistry = new PendingRegistry()

    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Interaction-Host',
    })

    // Register interaction RCP methods
    registerInteractionMethods(rcpServer, pendingRegistry, registry)

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // Pre-enroll device with P-256 approval key
    const ticketRes = await hostRelay.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
    const { privateKey, publicKeySpkiDer } = generateApprovalKeypair()

    device = new FakeDevice({ name: 'Pixel-Interaction-E2E' })
    await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)
    await device.connectToRelay(env.relayWsUrl)

    registry.addDevice({
      deviceId: device.deviceId,
      name: device.name,
      noisePublicKey: device.noiseKeypair.publicKey,
      devicePsk: device.devicePsk,
      approvalPublicKey: publicKeySpkiDer,
      createdAt: Date.now(),
      revoked: false,
    })

    // Open secure session channel
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })

    await channel.hello()

    // 1. Subscribe to interaction.follow stream
    const followRes = await channel.call<{ sid: number }>('interaction.follow', {})
    expect(typeof followRes.sid).toBe('number')

    const interactionStreamItems: any[] = []
    channel.onStreamItem(followRes.sid, (item) => {
      interactionStreamItems.push(item)
    })

    // Wait for baseline
    await new Promise((r) => setTimeout(r, 40))
    expect(interactionStreamItems).toHaveLength(1)
    expect(interactionStreamItems[0]?.type).toBe('baseline')

    // 2. Simulate dsh waterfall approval arrival (no browser answering -> waits for phone)
    let pcChainAborted = false
    const approvalReq: any = {
      toolName: 'execute_shell',
      arguments: { command: 'npm install' },
      agent: { session: { id: 'ses-e2e-1' } },
      signal: new AbortController().signal,
    }

    const nextWaterfall = () =>
      new Promise<string>((_, reject) => {
        approvalReq.signal.addEventListener('abort', () => {
          pcChainAborted = true
          reject(new Error('withdrawn'))
        })
      })

    const racePromise = raceApproval(approvalReq, nextWaterfall, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    // Wait for stream delta 'requested'
    await new Promise((r) => setTimeout(r, 40))
    expect(interactionStreamItems.length).toBeGreaterThanOrEqual(2)
    const reqItem = interactionStreamItems.find((it) => it.type === 'requested')
    expect(reqItem).toBeDefined()
    const approvalId = reqItem.pending.id
    const argsDigest = reqItem.pending.argsDigest

    // 3. Phone answers approval via RCP approvals.answer
    const answerRes = await channel.call<{ accepted: boolean; final: string; by: string }>('approvals.answer', {
      id: approvalId,
      outcome: 'allowed-once',
      argsDigest,
      issuedAt: Date.now(),
    })

    expect(answerRes.accepted).toBe(true)
    expect(answerRes.final).toBe('allowed-once')
    expect(answerRes.by).toBe('phone')

    // Dsh waterfall receives outcome and PC chain is withdrawn
    const dshOutcome = await racePromise
    expect(dshOutcome).toBe('allowed-once')
    expect(pcChainAborted).toBe(true)

    // Verify stream received 'resolved' delta
    await new Promise((r) => setTimeout(r, 40))
    const resolvedItem = interactionStreamItems.find((it) => it.type === 'resolved' && it.id === approvalId)
    expect(resolvedItem).toBeDefined()
    expect(resolvedItem.outcome).toBe('allowed-once')
    expect(resolvedItem.by).toBe('phone')

    // 4. Single-use: phone tries to answer the same approval again
    const secondAnswer = await channel.call<{ accepted: boolean; final: string; by: string }>('approvals.answer', {
      id: approvalId,
      outcome: 'rejected',
      argsDigest,
      issuedAt: Date.now(),
    })
    expect(secondAnswer.accepted).toBe(false)
    expect(secondAnswer.final).toBe('allowed-once')
    expect(secondAnswer.by).toBe('phone')

    // 5. High-risk approval with biometric signature
    const highRiskReq: any = {
      toolName: 'dangerous_rm',
      arguments: 'rm -rf /data',
    }
    const highRiskPromise = raceApproval(highRiskReq, () => new Promise(() => {}), pendingRegistry, {
      approvalTimeoutMs: 10_000,
      policyGuard: {
        evaluateApprovalRisk: () => ({ risk: 'high', requiresSignature: true }),
      },
      hasPairedDevices: () => true,
    })

    await new Promise((r) => setTimeout(r, 40))
    const highRiskItem = pendingRegistry.list().find((it) => it.kind === 'approval' && it.toolName === 'dangerous_rm')!
    expect(highRiskItem.requiresSignature).toBe(true)

    // Sign with P-256 key
    const issuedAt = Date.now()
    const canonicalMsg = buildCanonicalApprovalMessage({
      approvalId: highRiskItem.id,
      outcome: 'allowed-once',
      argsDigest: highRiskItem.argsDigest,
      issuedAt,
    })
    const sigDer = signApprovalMessage(privateKey, utf8ToBytes(canonicalMsg))
    const sigDerB64u = encodeBase64Url(sigDer)

    const signedAnswer = await channel.call<{ accepted: boolean; final: string; by: string }>('approvals.answer', {
      id: highRiskItem.id,
      outcome: 'allowed-once',
      argsDigest: highRiskItem.argsDigest,
      issuedAt,
      sig: sigDerB64u,
    })
    expect(signedAnswer.accepted).toBe(true)

    const highRiskOutcome = await highRiskPromise
    expect(highRiskOutcome).toBe('allowed-once')

    // 6. User question flow
    const questionReq: any = {
      questions: [
        {
          id: 'q_plan',
          question: 'Do you approve the execution plan?',
          options: [{ label: 'Approve' }, { label: 'Decline' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ],
      signal: new AbortController().signal,
    }

    const questionPromise = raceQuestion(questionReq, () => new Promise(() => {}), pendingRegistry, {
      questionTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    await new Promise((r) => setTimeout(r, 40))
    const qPending = pendingRegistry.list().find((it) => it.kind === 'question')!
    expect(qPending).toBeDefined()

    const qAnswerRes = await channel.call<{ accepted: boolean; by: string }>('questions.answer', {
      id: qPending.id,
      answers: [{ id: 'q_plan', selected: ['Approve'] }],
    })
    expect(qAnswerRes.accepted).toBe(true)
    expect(qAnswerRes.by).toBe('phone')

    const qResult: any = await questionPromise
    expect(qResult.answers[0]?.selected).toEqual(['Approve'])

    channel.cancelStream(followRes.sid)
  })
})
