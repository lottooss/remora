import { describe, expect, it } from 'vitest'
import {
  buildCanonicalApprovalMessage,
  computeArgsDigest,
  encodeBase64Url,
  generateApprovalKeypair,
  signApprovalMessage,
  utf8ToBytes,
} from '@remora/crypto'
import {
  InMemoryDeviceRegistry,
  PendingRegistry,
  RcpServer,
  raceApproval,
  raceQuestion,
  registerAnswerBridge,
  registerInteractionMethods,
} from '../src/index.ts'

const HOST_ID = 'h_erruijsx3ey2rmxcpeh3pgxjkm'
const DEVICE_ID = 'd_erruijsx3ey2rmxcpeh3pgxjkm'

describe('P3-H1: AnswerBridge — Approvals and Questions', () => {
  it('PendingRegistry: add, list, and single-use resolution', async () => {
    const registry = new PendingRegistry()
    const deltas: any[] = []
    const unsub = registry.subscribe((ev) => deltas.push(ev))

    registry.add({
      kind: 'approval',
      id: 'appr-1',
      sessionId: 'ses-1',
      sessionTitle: 'Test Session',
      toolName: 'bash',
      preview: { text: 'rm -rf /tmp/foo', json: '{"cmd":"rm -rf /tmp/foo"}' },
      argsDigest: computeArgsDigest({ text: 'rm -rf /tmp/foo', json: '{"cmd":"rm -rf /tmp/foo"}' }),
      risk: 'normal',
      requiresSignature: false,
      createdAt: 1000,
      expiresAt: 2000,
    })

    expect(registry.list()).toHaveLength(1)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.type).toBe('requested')

    // First resolution succeeds
    const first = registry.resolveApproval('appr-1', 'allowed-once', 'phone', 'dev-1')
    expect(first.accepted).toBe(true)
    expect(first.final).toBe('allowed-once')
    expect(first.by).toBe('phone')

    expect(registry.list()).toHaveLength(0) // No longer pending
    expect(deltas).toHaveLength(2)
    expect(deltas[1]?.type).toBe('resolved')
    expect(deltas[1]?.by).toBe('phone')

    // Second resolution is rejected (single-use)
    const second = registry.resolveApproval('appr-1', 'rejected', 'pc')
    expect(second.accepted).toBe(false)
    expect(second.final).toBe('allowed-once')
    expect(second.by).toBe('phone')

    unsub()
  })

  it('raceApproval: phone answers first, PC chain is withdrawn', async () => {
    const pendingRegistry = new PendingRegistry()
    let pcChainAborted = false

    const req: any = {
      toolName: 'execute_command',
      arguments: { command: 'git status' },
      agent: { session: { id: 'ses-1' } },
      signal: new AbortController().signal,
    }

    const next = () =>
      new Promise<string>((_resolve, reject) => {
        // PC chain waits, but should be aborted when phone answers
        req.signal.addEventListener('abort', () => {
          pcChainAborted = true
          reject(new Error('withdrawn'))
        })
      })

    const racePromise = raceApproval(req, next, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    const pending = pendingRegistry.list()[0]!
    expect(pending).toBeDefined()
    expect(pending.kind).toBe('approval')

    // Phone answers
    pendingRegistry.resolveApproval(pending.id, 'allowed-once', 'phone', 'd_test1')

    const outcome = await racePromise
    expect(outcome).toBe('allowed-once')
    expect(pcChainAborted).toBe(true)
  })

  it('raceApproval: PC GUI answers first, phone loses', async () => {
    const pendingRegistry = new PendingRegistry()

    const req: any = {
      toolName: 'read_file',
      arguments: { path: '/etc/hosts' },
      agent: { session: { id: 'ses-1' } },
    }

    const next = async () => {
      return 'allowed-once'
    }

    const outcome = await raceApproval(req, next, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    expect(outcome).toBe('allowed-once')
    // Item should be marked resolved by 'pc'
    const all = Array.from((pendingRegistry as any).items.values()) as any[]
    expect(all[0]?.resolution?.by).toBe('pc')
  })

  it('raceApproval: PC unavailable with paired devices waits for phone', async () => {
    const pendingRegistry = new PendingRegistry()

    const req: any = {
      toolName: 'run_task',
      arguments: 'echo hello',
    }

    // PC returns unavailable (zero clients / passive)
    const next = async () => 'unavailable'

    const racePromise = raceApproval(req, next, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    // Give next() a moment to settle
    await new Promise((r) => setTimeout(r, 20))

    const pending = pendingRegistry.list()[0]!
    expect(pending).toBeDefined()

    // Phone answers later
    pendingRegistry.resolveApproval(pending.id, 'rejected', 'phone')

    const outcome = await racePromise
    expect(outcome).toBe('rejected')
  })

  it('raceApproval: signal abort cancels the approval wait', async () => {
    const pendingRegistry = new PendingRegistry()
    const abortCtrl = new AbortController()

    const req: any = {
      toolName: 'long_task',
      signal: abortCtrl.signal,
    }

    const next = () => new Promise<string>(() => {})

    const racePromise = raceApproval(req, next, pendingRegistry, {
      approvalTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    abortCtrl.abort()

    const outcome = await racePromise
    expect(outcome).toBe('cancelled')
  })

  it('raceQuestion: phone answers question, PC chain withdrawn', async () => {
    const pendingRegistry = new PendingRegistry()
    let pcAborted = false

    const req: any = {
      questions: [{ id: 'q1', question: 'Proceed?' }],
      signal: new AbortController().signal,
    }

    const next = () =>
      new Promise<any>((_, reject) => {
        req.signal.addEventListener('abort', () => {
          pcAborted = true
          reject(new Error('withdrawn'))
        })
      })

    const racePromise = raceQuestion(req, next, pendingRegistry, {
      questionTimeoutMs: 10_000,
      hasPairedDevices: () => true,
    })

    const pending = pendingRegistry.list()[0]!
    expect(pending.kind).toBe('question')

    pendingRegistry.resolveQuestion(pending.id, [{ id: 'q1', selected: ['yes'] }], 'phone')

    const res: any = await racePromise
    expect(res.answers[0]?.selected).toEqual(['yes'])
    expect(pcAborted).toBe(true)
  })

  it('RCP interaction methods: follow, approvals.answer (with signature check), questions.answer', async () => {
    const pendingRegistry = new PendingRegistry()
    const deviceRegistry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({ hostId: HOST_ID, hostName: 'Host' })

    // Generate EC P-256 approval key for fake device
    const { privateKey, publicKeySpkiDer } = generateApprovalKeypair()

    // The device is looked up by the authenticated connection's device id
    // (Crypto/1 §7: identity comes from the connection, never the answer).
    deviceRegistry.addDevice({
      deviceId: DEVICE_ID,
      name: 'Phone',
      noisePublicKey: new Uint8Array(32),
      devicePsk: new Uint8Array(32),
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      approvalPublicKey: publicKeySpkiDer,
      revoked: false,
    })

    registerInteractionMethods(rcpServer, pendingRegistry, deviceRegistry, undefined, HOST_ID)

    // Add high-risk pending approval requiring signature
    const preview = { text: 'deploy production', json: '{"target":"prod"}' }
    const argsDigest = computeArgsDigest(preview)
    const issuedAt = Date.now()

    pendingRegistry.add({
      kind: 'approval',
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: 'ses-1',
      sessionTitle: null,
      toolName: 'deploy',
      preview,
      argsDigest,
      risk: 'high',
      requiresSignature: true,
      createdAt: issuedAt,
      expiresAt: issuedAt + 60_000,
    })

    const ctx = { deviceId: DEVICE_ID, channelId: 1 }

    // 1. approvals.answer without signature -> fails with signature_required
    const errRes: any = JSON.parse(
      (await rcpServer.handleMessage(
        JSON.stringify({
          k: 'req',
          id: 1,
          m: 'approvals.answer',
          p: {
            id: '11111111-1111-4111-8111-111111111111',
            outcome: 'allowed-once',
            argsDigest,
            issuedAt,
          },
        }),
        ctx,
      ))!,
    )
    expect(errRes.ok).toBe(false)
    expect(errRes.e?.code).toBe('signature_required')

    // 2. approvals.answer with valid P-256 signature
    const msg = buildCanonicalApprovalMessage({
      hostId: HOST_ID,
      deviceId: DEVICE_ID,
      sessionId: 'ses-1',
      toolName: 'deploy',
      approvalId: '11111111-1111-4111-8111-111111111111',
      outcome: 'allowed-once',
      argsDigest,
      issuedAt,
    })
    const sigDer = signApprovalMessage(privateKey, utf8ToBytes(msg))
    const sigDerB64u = encodeBase64Url(sigDer)

    const answerRes: any = JSON.parse(
      (await rcpServer.handleMessage(
        JSON.stringify({
          k: 'req',
          id: 2,
          m: 'approvals.answer',
          p: {
            id: '11111111-1111-4111-8111-111111111111',
            outcome: 'allowed-once',
            argsDigest,
            issuedAt,
            sig: sigDerB64u,
          },
        }),
        ctx,
      ))!,
    )

    expect(answerRes.ok).toBe(true)
    expect(answerRes.r.accepted).toBe(true)
    expect(answerRes.r.final).toBe('allowed-once')
    expect(answerRes.r.by).toBe('phone')

    // 3. questions.answer
    pendingRegistry.add({
      kind: 'question',
      id: '22222222-2222-4222-8222-222222222222',
      sessionId: 'ses-1',
      sessionTitle: null,
      questions: [{ id: 'choice', question: 'Pick an option' }],
      createdAt: issuedAt,
      expiresAt: issuedAt + 60_000,
    })

    const qAnswer: any = JSON.parse(
      (await rcpServer.handleMessage(
        JSON.stringify({
          k: 'req',
          id: 3,
          m: 'questions.answer',
          p: {
            id: '22222222-2222-4222-8222-222222222222',
            answers: [{ id: 'choice', selected: ['opt-A'] }],
          },
        }),
        ctx,
      ))!,
    )

    expect(qAnswer.ok).toBe(true)
    expect(qAnswer.r.accepted).toBe(true)
    expect(qAnswer.r.by).toBe('phone')
  })

  it('registerAnswerBridge: delegates transparently when no devices paired', async () => {
    const emptyRegistry = new InMemoryDeviceRegistry()
    const pendingRegistry = new PendingRegistry()

    let nextCalled = false
    const listeners = new Map<string, any>()
    const fakeCtx: any = {
      on: (event: string, handler: any) => {
        listeners.set(event, handler)
        return () => listeners.delete(event)
      },
      logger: { error: () => {}, info: () => {} },
    }

    const dispose = registerAnswerBridge(fakeCtx, {
      registry: emptyRegistry,
      pendingRegistry,
    })

    const approvalHandler = listeners.get('approval/request')
    expect(approvalHandler).toBeDefined()

    const res = await approvalHandler(
      { toolName: 'bash' },
      async () => {
        nextCalled = true
        return 'allowed-once'
      },
    )

    expect(nextCalled).toBe(true)
    expect(res).toBe('allowed-once')
    expect(pendingRegistry.list()).toHaveLength(0) // No pending items created!

    dispose()
  })
})
