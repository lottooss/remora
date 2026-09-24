import { describe, expect, it, afterEach } from 'vitest'
import {
  ChannelManager,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  RcpServer,
  SessionAdapter,
  createHostIdentity,
  enrollHost,
  registerSessionMethods,
  type TypertGateway,
} from '@remora/host'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

describe('End-to-End Sessions Flow (P2-H2)', () => {
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

  it('runs complete sessions e2e: list, prompt, cancel, and follow with live deltas', async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()

    const hostIdentity = createHostIdentity()
    await enrollHost(env.relayHttpUrl, env.enrollSecret, hostIdentity, 'E2E-Sessions-Host')

    const registry = new InMemoryDeviceRegistry()
    const rcpServer = new RcpServer({
      hostId: hostIdentity.hostId,
      hostName: 'E2E-Sessions-Host',
    })

    // Mock dsh TypertGateway for the session adapter
    let cancelCalled = false
    const fakeGateway: TypertGateway = {
      invoke: async (req) => {
        if (req.method === 'list') {
          return {
            items: [
              {
                sessionId: 'session-e2e-1',
                updatedAt: Date.now(),
                running: true,
                cwd: 'C:\\Users\\test\\workspace',
                projections: {
                  values: {
                    title: 'E2E Test Session',
                    modelSelection: { lastUsed: { provider: 'mock', model: 'flash' } },
                  },
                },
              },
            ],
          }
        }
        if (req.method === 'prompt') {
          return { accepted: true }
        }
        if (req.method === 'cancel') {
          cancelCalled = true
          return { accepted: true }
        }
        if (req.method === 'page') {
          return { records: [], hasMore: false }
        }
        return {}
      },
      stream: async function* () {
        // Yield initial snapshot
        yield {
          type: 'snapshot',
          header: { id: 'session-e2e-1', createdAt: 1000, version: 1, isSeeded: false },
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

        // Yield live assistant stream frames
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'start',
            attemptId: 'att_e2e_1',
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
            attemptId: 'att_e2e_1',
            revision: 2,
            index: 0,
            time: 1010,
            chunk: { type: 'text-delta', text: 'Hello from mock LLM!' },
          },
        }

        yield {
          type: 'assistant-stream',
          frame: {
            type: 'end',
            attemptId: 'att_e2e_1',
            revision: 3,
            index: 1,
            outcome: { kind: 'committed' },
          },
        }

        // Yield durable settled assistant message
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
                content: [{ type: 'text', text: 'Hello from mock LLM!' }],
                source: { provider: 'mock', model: 'flash' },
              },
            },
          },
        }

        // Keep stream open until cancellation
        await new Promise((_resolve) => {})
      },
    }

    const adapter = new SessionAdapter({
      gateway: fakeGateway,
      streamCoalesceMs: 10,
    })
    registerSessionMethods(rcpServer, adapter)

    hostRelay = new HostRelayConnection({
      relayUrl: env.relayWsUrl,
      identity: hostIdentity,
    })

    const channelManager = new ChannelManager({
      identity: hostIdentity,
      registry,
      rcpServer,
      sendFrame: (bytes) => {
        hostRelay!.sendFrameBytes(bytes)
      },
    })

    hostRelay.attachChannelManager(channelManager)
    hostRelay.start()

    // Wait until host is connected
    await new Promise<void>((resolve) => {
      if (hostRelay!.isConnected) return resolve()
      hostRelay!.link.once('ready', () => resolve())
    })

    // Get enrollment ticket
    const ticketRes = await hostRelay.link.request<{ ticket: string }>({
      t: 'enroll.ticket',
    })

    // Device enrolls and connects
    device = new FakeDevice({ name: 'Pixel Sessions E2E' })
    await device.enrollAtRelay(env.relayHttpUrl, ticketRes.ticket)
    registry.addDevice({
      deviceId: device.deviceId,
      devicePsk: device.devicePsk,
      noisePublicKey: device.noiseKeypair.publicKey,
      createdAt: Date.now(),
      name: device.name,
      revoked: false,
    })

    await device.connectToRelay(env.relayWsUrl)

    // Open secure channel
    const channel = await device.openSecureChannel({
      hostId: hostIdentity.hostId,
      hostNoisePublicKey: hostIdentity.noiseKeypair.publicKey,
      channelId: 1,
    })

    // Handshake hello
    const hello = await channel.hello()
    expect(hello.rcp).toEqual([1])

    // 1. sessions.list
    const listRes = await channel.call<{ items: Array<{ id: string; title: string }> }>('sessions.list', {})
    expect(listRes.items.length).toBeGreaterThan(0)
    expect(listRes.items[0]?.id).toBe('session-e2e-1')
    expect(listRes.items[0]?.title).toBe('E2E Test Session')

    // 2. sessions.prompt
    const promptRes = await channel.call<{ accepted: boolean; duplicate: boolean }>('sessions.prompt', {
      sessionId: 'session-e2e-1',
      requestId: '33333333-3333-4333-8333-333333333333',
      text: 'Run e2e test turn',
      delivery: 'queue',
    })
    expect(promptRes.accepted).toBe(true)
    expect(promptRes.duplicate).toBe(false)

    // 3. sessions.cancel
    const cancelRes = await channel.call<{ requested: boolean }>('sessions.cancel', {
      sessionId: 'session-e2e-1',
      requestId: '44444444-4444-4444-8444-444444444444',
    })
    expect(cancelRes.requested).toBe(true)
    expect(cancelCalled).toBe(true)

    // 4. sessions.follow stream
    const streamItems: any[] = []
    const followRes = await channel.call<{ sid: number }>('sessions.follow', {
      sessionId: 'session-e2e-1',
    })
    expect(typeof followRes.sid).toBe('number')

    channel.onStreamItem(followRes.sid, (item) => {
      streamItems.push(item)
    })

    // Wait for items to be delivered through the secure channel
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(streamItems.length).toBeGreaterThanOrEqual(2)
    // Check initial snapshot
    expect(streamItems[0]?.type).toBe('snapshot')
    expect(streamItems[0]?.session?.id).toBe('session-e2e-1')

    // Check live or events frames
    const hasLiveStart = streamItems.some((it) => it.type === 'live.start')
    expect(hasLiveStart).toBe(true)

    const hasEvents = streamItems.some((it) => it.type === 'events')
    expect(hasEvents).toBe(true)

    // 5. Cancel stream
    channel.cancelStream(followRes.sid)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(rcpServer.activeStreamCount(device.deviceId)).toBe(0)
  })
})
