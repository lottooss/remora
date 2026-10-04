import { describe, expect, it, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  PairingService,
  RcpServer,
  SessionAdapter,
  createHostIdentity,
  enrollHost,
  registerSessionMethods,
  type TypertGateway,
} from '@remora/host'
import { decodeBase64Url } from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'
import { createFixtureHostRuntime } from '../helpers/host-runtime.ts'

describe('End-to-End Vertical Slice (P2-T1)', () => {
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

  it('verifies pairing lifecycle: confirm, reject, and timeout', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Pairing-Host')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Pairing-Host',
      runtimeProvider: createFixtureHostRuntime(),
    })

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'E2E-Pairing-Host',
      relayOrigin: env.relayHttpUrl,
      registry,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
      requestEnrollmentTicket: async () => {
        const res = await hostRelay!.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
        return decodeBase64Url(res.ticket)
      },
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      pairingService,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // 1. Successful pairing with SAS confirmation
    const attempt1 = await pairingService.beginPairing()
    device = new FakeDevice({ name: 'Pixel-Pair-Success' })

    const pairFlow1 = await device.startPairing(attempt1.qrPayload, env.relayHttpUrl)
    expect(pairFlow1.sasCode.length).toBe(6)
    expect(pairingService.getActiveAttempt()?.sasCode).toBe(pairFlow1.sasCode)

    const confirmed = await pairingService.confirmPairing(pairFlow1.sasCode)
    expect(confirmed).toBe(true)

    const pairResult1 = await pairFlow1.waitForResult()
    expect(pairResult1.ok).toBe(true)
    if (pairResult1.ok) {
      expect(pairResult1.devicePsk.length).toBe(32)
    }

    // Verify paired device can now open a normal secure channel
    const channel1 = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 2,
    })
    const hello = await channel1.hello()
    expect(hello.host.id).toBe(hostIdentity.hostId)
    await device.disconnect()

    // 2. Rejected pairing
    const attempt2 = await pairingService.beginPairing()
    const device2 = new FakeDevice({ name: 'Pixel-Pair-Reject' })
    const pairFlow2 = await device2.startPairing(attempt2.qrPayload, env.relayHttpUrl)
    expect(pairFlow2.sasCode.length).toBe(6)

    await pairingService.rejectPairing('rejected')
    const pairResult2 = await pairFlow2.waitForResult()
    expect(pairResult2.ok).toBe(false)
    if (!pairResult2.ok) {
      expect(pairResult2.reason).toBe('rejected')
    }
    await device2.disconnect()

    // 3. Timeout pairing
    const attempt3 = await pairingService.beginPairing()
    const device3 = new FakeDevice({ name: 'Pixel-Pair-Timeout' })
    const pairFlow3 = await device3.startPairing(attempt3.qrPayload, env.relayHttpUrl)

    await pairingService.rejectPairing('timeout')
    const pairResult3 = await pairFlow3.waitForResult()
    expect(pairResult3.ok).toBe(false)
    if (!pairResult3.ok) {
      expect(pairResult3.reason).toBe('timeout')
    }
    await device3.disconnect()
  })

  it('runs complete sessions vertical slice: follow, queue/steer prompt, deduplication, cancel, mid-stream reconnect, and cold recovery', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-FullSlice-Host')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-FullSlice-Host',
      runtimeProvider: createFixtureHostRuntime(),
    })

    let promptCount = 0
    let lastPromptMode = ''
    let cancelCount = 0

    const mockGateway: TypertGateway = {
      invoke: async (req) => {
        if (req.method === 'list') {
          return {
            items: [
              {
                sessionId: 'session-vs-1',
                updatedAt: Date.now(),
                running: true,
                cwd: 'C:\\Users\\test\\workspace',
                projections: {
                  values: {
                    title: 'Vertical Slice Session',
                    modelSelection: { lastUsed: { provider: 'mock', model: 'flash' } },
                  },
                },
              },
            ],
          }
        }
        if (req.method === 'prompt') {
          promptCount += 1
          const rawArgs = req.args ?? (req as any).params
          lastPromptMode = (rawArgs as any)?.mode ?? 'queue'
          return { accepted: true }
        }
        if (req.method === 'cancel') {
          cancelCount += 1
          return { accepted: true }
        }
        if (req.method === 'page') {
          return { records: [], hasMore: false }
        }
        return {}
      },
      stream: async function* () {
        // Initial snapshot
        yield {
          type: 'snapshot',
          header: { id: 'session-vs-1', createdAt: 1000, version: 1, isSeeded: false },
          cursor: 1,
          records: [
            {
              type: 'event',
              event: {
                type: 'turn/start',
                seq: 1,
                time: 1000,
                data: { turn: 1 },
              },
            },
          ],
          hasMore: false,
        }

        // Live stream deltas
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'start',
            attemptId: 'att_vs_1',
            revision: 1,
            turn: 1,
            step: 1,
            startedAfterSeq: 1,
          },
        }

        yield {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'att_vs_1',
            revision: 2,
            index: 0,
            time: 1010,
            chunk: { type: 'text-delta', text: 'Live streaming delta chunk' },
          },
        }

        yield {
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: 'att_vs_1',
            revision: 3,
            index: 1,
            outcome: { kind: 'committed' },
          },
        }

        // Durable settlement event
        yield {
          type: 'event',
          event: {
            type: 'assistant/message',
            seq: 2,
            time: 1020,
            data: {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Live streaming delta chunk' }],
                source: { provider: 'mock', model: 'flash' },
              },
            },
          },
        }

        // Keep stream alive
        await new Promise((_resolve) => {})
      },
    }

    const adapter = new SessionAdapter({
      gateway: mockGateway,
      streamCoalesceMs: 10,
    })
    registerSessionMethods(rcpServer, adapter)

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const pairingService = new PairingService({
      identity: hostIdentity,
      hostName: 'E2E-FullSlice-Host',
      relayOrigin: env.relayHttpUrl,
      registry,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
      requestEnrollmentTicket: async () => {
        const res = await hostRelay!.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
        return decodeBase64Url(res.ticket)
      },
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      pairingService,
      sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // 1. Pairing
    const attempt = await pairingService.beginPairing()
    device = new FakeDevice({ name: 'Pixel-Vertical-Slice' })
    const pairFlow = await device.startPairing(attempt.qrPayload, env.relayHttpUrl)
    await pairingService.confirmPairing(pairFlow.sasCode)
    const pairResult = await pairFlow.waitForResult()
    expect(pairResult.ok).toBe(true)

    // 2. Open secure session channel
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 2,
    })

    const hello = await channel.hello()
    expect(hello.host.name).toBe('E2E-FullSlice-Host')

    // 3. sessions.list
    const listRes = await channel.call<{ items: Array<{ id: string; title: string }> }>('sessions.list', {})
    expect(listRes.items.length).toBe(1)
    expect(listRes.items[0]?.id).toBe('session-vs-1')

    // 4. sessions.prompt with delivery: 'queue'
    const promptReqId = '11111111-1111-4111-8111-111111111111'
    const prompt1 = await channel.call<{ accepted: boolean; duplicate: boolean }>('sessions.prompt', {
      sessionId: 'session-vs-1',
      requestId: promptReqId,
      text: 'First prompt turn',
      delivery: 'queue',
    })
    expect(prompt1.accepted).toBe(true)
    expect(prompt1.duplicate).toBe(false)
    expect(promptCount).toBe(1)
    expect(lastPromptMode).toBe('queue')

    // 5. sessions.prompt duplicate check with same requestId
    const promptDup = await channel.call<{ accepted: boolean; duplicate: boolean }>('sessions.prompt', {
      sessionId: 'session-vs-1',
      requestId: promptReqId,
      text: 'First prompt turn',
      delivery: 'queue',
    })
    expect(promptDup.accepted).toBe(true)
    expect(promptDup.duplicate).toBe(true)
    expect(promptCount).toBe(1) // Not dispatched twice!

    // 6. sessions.prompt with delivery: 'steer'
    const steerReqId = '22222222-2222-4222-8222-222222222222'
    const promptSteer = await channel.call<{ accepted: boolean; duplicate: boolean }>('sessions.prompt', {
      sessionId: 'session-vs-1',
      requestId: steerReqId,
      text: 'Steering instruction',
      delivery: 'steer',
    })
    expect(promptSteer.accepted).toBe(true)
    expect(promptSteer.duplicate).toBe(false)
    expect(promptCount).toBe(2)
    expect(lastPromptMode).toBe('steer')

    // 7. sessions.cancel
    const cancelRes = await channel.call<{ requested: boolean }>('sessions.cancel', {
      sessionId: 'session-vs-1',
      requestId: '33333333-3333-4333-8333-333333333333',
    })
    expect(cancelRes.requested).toBe(true)
    expect(cancelCount).toBe(1)

    // 8. Follow stream from scratch: receives snapshot -> live stream deltas -> settled events
    const follow1 = await channel.call<{ sid: number }>('sessions.follow', {
      sessionId: 'session-vs-1',
    })
    expect(typeof follow1.sid).toBe('number')

    const items1 = await channel.collectStreamItems(
      follow1.sid,
      (items) => items.some((it) => it.type === 'events'),
      5000,
    )
    expect(items1[0]?.type).toBe('snapshot')
    expect(items1[0]?.session?.id).toBe('session-vs-1')
    expect(items1.some((it) => it.type === 'live.start')).toBe(true)
    expect(items1.some((it) => it.type === 'events')).toBe(true)

    channel.cancelStream(follow1.sid)

    // 9. Follow stream with afterSeq: receives only events after seq, no snapshot
    const follow2 = await channel.call<{ sid: number }>('sessions.follow', {
      sessionId: 'session-vs-1',
      afterSeq: 1,
    })
    const items2 = await channel.collectStreamItems(
      follow2.sid,
      (items) => items.some((it) => it.type === 'events'),
      5000,
    )
    expect(items2.some((it) => it.type === 'snapshot')).toBe(false)
    const eventItem = items2.find((it) => it.type === 'events')
    expect(eventItem.events[0]?.seq).toBe(2)

    channel.cancelStream(follow2.sid)

    // 10. Mid-stream relay disconnect & reconnect
    await device.disconnect()
    expect(device.isConnected).toBe(false)

    // Reconnect to relay
    await device.connectToRelay(env.relayWsUrl)
    expect(device.isConnected).toBe(true)

    // Reopen secure channel (Noise IKpsk2) using saved credentials
    const reconnectedChannel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 3,
    })

    const statusAfterReconnect = await reconnectedChannel.hostStatus()
    expect(registry.listDevices().filter((d) => !d.revoked)).toHaveLength(1)
    expect(statusAfterReconnect.dsh).toEqual({ version: 'fake-dsh', profile: 'remora-e2e' })

    // 11. Cold recovery: host restarts, device re-establishes session without re-pairing
    await hostRelay.stop()

    const newHostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })
    const newChannelManager = new ChannelManager({
      identity: hostIdentity,
      registry, // Persistent device registry
      rcpServer,
      sendFrame: (bytes) => newHostRelay.sendFrameBytes(bytes),
    })
    newHostRelay.attachChannelManager(newChannelManager)
    newHostRelay.start()

    await new Promise<void>((resolve) => {
      if (newHostRelay.isConnected) return resolve()
      newHostRelay.link.once('ready', () => resolve())
    })
    hostRelay = newHostRelay

    const recoveredChannel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 4,
    })
    const recoveredList = await recoveredChannel.call<{ items: Array<{ id: string }> }>('sessions.list', {})
    expect(recoveredList.items[0]?.id).toBe('session-vs-1')
  })
})
