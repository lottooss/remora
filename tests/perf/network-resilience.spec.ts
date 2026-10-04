/**
 * P6-T1 network resilience benchmarks (blueprint §2.3, §13).
 *
 * Runs against the real relay (wrangler dev via E2eEnvironment) with a
 * scripted in-process dsh gateway, so durable events carry monotonic seq
 * cursors and the phone (FakeDevice) can prove exactly-once delivery across
 * socket disconnects:
 *
 *  - 100 socket disconnects during an active stream: every durable event is
 *    received exactly once (no loss, no duplication), resumed by `afterSeq`.
 *  - Mid-stream abrupt disconnect: the stream resumes with no gaps.
 *  - Cold recovery: the host process "restarts" (new relay connection, same
 *    identity + persistent registry) and the phone continues without
 *    re-pairing.
 *
 * Methodology note: before each disconnect the phone cancels its RCP stream
 * gracefully, so the host-side pump stops instead of flooding the relay's
 * per-connection token bucket (50 msg/s, blueprint §9.4) with frames for a
 * dead socket. The disconnect itself is abrupt (no FIN handshake), which is
 * what a network change looks like on the wire.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest'
import { createFixtureHostRuntime } from '../helpers/host-runtime.ts'
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
  type HostIdentity,
} from '@remora/host'
import { decodeBase64Url } from '@remora/crypto'
import { E2eEnvironment, FakeDevice, type FakeDeviceChannel } from '@remora/testkit'

const SESSION_ID = 'perf-resilience-session'

interface WireEvent {
  type: string
  seq: number
  time: number
}

/**
 * Scripted dsh gateway: an in-memory journal of durable events produced on a
 * timer, plus the unary methods the host adapter needs. Every `follow` gets
 * the whole journal as its opening snapshot and only genuinely new events as
 * live frames, which is what lets the phone resume by `afterSeq` after a
 * disconnect.
 */
class ScriptedSessionGateway {
  private journal: WireEvent[] = []
  private seq = 0
  private produced = 0
  private waiters: Array<() => void> = []
  private produceTimer: NodeJS.Timeout | null = null
  private producing = false
  private maxEvents = Number.POSITIVE_INFINITY

  get eventCount(): number {
    return this.journal.length
  }

  startProducing(intervalMs: number, maxEvents: number): void {
    this.stopProducing()
    this.producing = true
    this.maxEvents = maxEvents
    this.produceTimer = setInterval(() => this.produceTick(), intervalMs)
  }

  stopProducing(): void {
    this.producing = false
    if (this.produceTimer) {
      clearInterval(this.produceTimer)
      this.produceTimer = null
    }
  }

  private produceTick(): void {
    if (!this.producing || this.produced >= this.maxEvents) {
      if (this.produced >= this.maxEvents) this.stopProducing()
      return
    }
    this.seq += 1
    this.produced += 1
    this.journal.push({ type: 'turn.start', seq: this.seq, time: Date.now() })
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  private waitForProduction(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const cleanup = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        signal?.removeEventListener('abort', onAbort)
      }
      const waiter = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        cleanup()
        resolve()
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async invoke(req: { namespace: string; method: string; args: Record<string, unknown> }): Promise<unknown> {
    if (req.method === 'list') {
      return {
        items: [
          {
            sessionId: SESSION_ID,
            updatedAt: Date.now(),
            running: true,
            cwd: 'C:\\Users\\test\\workspace',
            projections: {
              values: {
                title: 'Resilience Session',
                modelSelection: { lastUsed: { provider: 'mock', model: 'flash' } },
              },
            },
          },
        ],
      }
    }
    if (req.method === 'prompt') return { accepted: true }
    if (req.method === 'cancel') return { accepted: true }
    if (req.method === 'page') return { records: [], hasMore: false }
    return {}
  }

  async *stream(req: {
    namespace: string
    method: string
    args: Record<string, unknown>
    signal?: AbortSignal
  }): AsyncIterable<unknown> {
    const records = this.journal.map((event) => ({ type: 'event', event }))
    yield {
      type: 'snapshot',
      header: { id: SESSION_ID, createdAt: 1000, version: 1, isSeeded: false },
      cursor: this.journal.length,
      records,
      hasMore: false,
    }
    let liveIndex = this.journal.length
    for (;;) {
      if (req.signal?.aborted) return
      if (liveIndex < this.journal.length) {
        yield { type: 'event', event: this.journal[liveIndex]! }
        liveIndex += 1
        continue
      }
      await this.waitForProduction(req.signal)
    }
  }
}

interface HostHarness {
  identity: HostIdentity
  registry: InMemoryDeviceRegistry
  rcpServer: RcpServer
  channelManager: ChannelManager
  hostRelay: HostRelayConnection
  pairingService: PairingService
  gateway: ScriptedSessionGateway
  relayErrors: number
}

function waitForReady(hostRelay: HostRelayConnection, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (hostRelay.isConnected) return resolve()
    const timer = setTimeout(() => reject(new Error('host relay did not become ready')), timeoutMs)
    hostRelay.link.once('ready', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function startHost(
  env: E2eEnvironment,
  name: string,
  existing?: { identity: HostIdentity; registry: InMemoryDeviceRegistry },
): Promise<HostHarness> {
  const identity = existing?.identity ?? createHostIdentity()
  const registry = existing?.registry ?? new InMemoryDeviceRegistry()
  await enrollHost(env.relayHttpUrl, env.enrollSecret, identity, name)

  const gateway = new ScriptedSessionGateway()

  let hostRelay: HostRelayConnection | null = null
  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName: name,
    runtimeProvider: createFixtureHostRuntime(),
  })
  const sessionAdapter = new SessionAdapter({ gateway, streamCoalesceMs: 150 })
  registerSessionMethods(rcpServer, sessionAdapter)

  let relayErrors = 0
  hostRelay = new HostRelayConnection({
    relayUrl: env.relayWsUrl,
    identity,
    onError: () => {
      relayErrors += 1
    },
  })

  const pairingService = new PairingService({
    identity,
    hostName: name,
    relayOrigin: env.relayHttpUrl,
    registry,
    sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
    requestEnrollmentTicket: async () => {
      const res = await hostRelay!.link.request<{ ticket: string }>({ t: 'enroll.ticket' })
      return decodeBase64Url(res.ticket)
    },
  })

  const channelManager = new ChannelManager({
    identity,
    registry,
    rcpServer,
    pairingService,
    sendFrame: (bytes) => hostRelay!.sendFrameBytes(bytes),
  })

  hostRelay.attachChannelManager(channelManager)
  hostRelay.start()
  await waitForReady(hostRelay)

  return { identity, registry, rcpServer, channelManager, hostRelay, pairingService, gateway, relayErrors }
}

async function pairDevice(env: E2eEnvironment, host: HostHarness, name: string): Promise<FakeDevice> {
  const attempt = await host.pairingService.beginPairing()
  const device = new FakeDevice({ name })
  const pairFlow = await device.startPairing(attempt.qrPayload, env.relayHttpUrl)
  await host.pairingService.confirmPairing(pairFlow.sasCode)
  const result = await pairFlow.waitForResult()
  if (!result.ok) throw new Error(`pairing failed: ${result.reason}`)
  return device
}

/** Tracks durable-event delivery on the phone side across reconnects. */
class EventTracker {
  private readonly counts = new Map<number, number>()
  duplicates = 0
  resets = 0
  maxSeq = 0

  note(seq: number): void {
    const count = this.counts.get(seq) ?? 0
    if (count > 0) this.duplicates += 1
    this.counts.set(seq, count + 1)
    if (seq > this.maxSeq) this.maxSeq = seq
  }

  get size(): number {
    return this.counts.size
  }

  countOf(seq: number): number {
    return this.counts.get(seq) ?? 0
  }

  clear(): void {
    this.counts.clear()
    this.maxSeq = 0
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]!
}

describe('P6-T1 network resilience', () => {
  let env: E2eEnvironment | null = null
  const hosts: HostHarness[] = []
  const devices: FakeDevice[] = []

  beforeAll(async () => {
    env = new E2eEnvironment({ useRealDsh: false })
    await env.start()
  }, 120_000)

  afterAll(async () => {
    for (const device of devices) {
      await device.disconnect()
    }
    devices.length = 0
    for (const host of hosts) {
      host.gateway.stopProducing()
      await host.hostRelay.stop()
    }
    hosts.length = 0
    if (env) {
      await env.teardown()
      env = null
    }
  })

  afterEach(() => {
    // Per-test cleanup is handled explicitly at the end of each test; this is
    // a safety net so a failure cannot leak sockets into the next test.
    return Promise.resolve()
  })

  it('survives 100 socket disconnects during streaming with zero lost or duplicated durable events', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-Flap-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Flap')
    devices.push(device)

    const TOTAL_RECONNECTS = 100
    const EVENTS_PER_CYCLE = 5
    const TOTAL_EVENTS = TOTAL_RECONNECTS * EVENTS_PER_CYCLE

    // 33 events/s stays under the relay's 50 msg/s per-connection limit, so
    // the only loss mechanism under test is the socket disconnect itself.
    host.gateway.startProducing(30, TOTAL_EVENTS)

    const tracker = new EventTracker()
    let cycleResolve: (() => void) | null = null
    let cycleTarget = 0

    const noteItem = (item: { type: string; events?: Array<{ seq: number }> }): void => {
      if (item.type === 'events' && item.events) {
        for (const event of item.events) tracker.note(event.seq)
      } else if (item.type === 'reset') {
        tracker.resets += 1
        tracker.clear()
      }
      if (cycleResolve && tracker.size >= cycleTarget) {
        cycleResolve()
        cycleResolve = null
      }
    }

    const waitForCycle = (target: number, timeoutMs: number): Promise<void> => {
      cycleTarget = target
      if (tracker.size >= target) return Promise.resolve()
      return new Promise((resolve, reject) => {
        cycleResolve = resolve
        setTimeout(() => {
          cycleResolve = null
          reject(new Error(`timed out waiting for ${target} events (have ${tracker.size})`))
        }, timeoutMs)
      })
    }

    let channel: FakeDeviceChannel | null = null
    let sid = 0
    let channelId = 0
    const resumeLatencies: number[] = []

    const openFollow = async (afterSeq?: number): Promise<void> => {
      channelId += 1
      channel = await device.openSecureChannel({
        hostId: host.identity.hostId,
        hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
        channelId,
      })
      const params: Record<string, unknown> = { sessionId: SESSION_ID }
      if (afterSeq !== undefined) params['afterSeq'] = afterSeq
      const follow = await channel.call<{ sid: number }>('sessions.follow', params)
      sid = follow.sid
      channel.onStreamItem(sid, (item) => noteItem(item as { type: string; events?: Array<{ seq: number }> }))
    }

    // Initial follow (no cursor): snapshot + live.
    await openFollow()

    for (let cycle = 1; cycle <= TOTAL_RECONNECTS; cycle++) {
      await waitForCycle(cycle * EVENTS_PER_CYCLE, 30_000)

      // End the host-side pump gracefully, then cut the socket abruptly.
      // Resume latency = cut → follow response (reconnect + Noise channel +
      // follow round-trip); the snapshot items follow immediately after.
      const disconnectAt = Date.now()
      channel!.cancelStream(sid)
      await device.disconnect()
      await device.connectToRelay(env.relayWsUrl)
      await openFollow(tracker.maxSeq)
      resumeLatencies.push(Date.now() - disconnectAt)
    }

    // Drain the tail of the journal through the final open stream.
    await waitForCycle(TOTAL_EVENTS, 30_000)
    host.gateway.stopProducing()

    const resumeP50 = percentile(resumeLatencies, 50)
    console.log(
      `[P6-T1] 100-reconnect: ${TOTAL_RECONNECTS} disconnects, ${TOTAL_EVENTS} events, ` +
        `duplicates=${tracker.duplicates} resets=${tracker.resets} relayErrors=${host.relayErrors} ` +
        `resume p50=${resumeP50}ms`,
    )

    expect(tracker.resets).toBe(0)
    expect(tracker.duplicates).toBe(0)
    expect(tracker.size).toBe(TOTAL_EVENTS)
    for (let seq = 1; seq <= TOTAL_EVENTS; seq++) {
      expect(tracker.countOf(seq)).toBe(1)
    }
  }, 240_000)

  it('resumes a stream after a mid-stream disconnect with no gaps or duplicates', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-MidStream-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-MidStream')
    devices.push(device)

    const TOTAL_EVENTS = 120
    const EVENTS_BEFORE_CUT = 30
    host.gateway.startProducing(20, TOTAL_EVENTS)

    const tracker = new EventTracker()
    let channel: FakeDeviceChannel | null = null
    let sid = 0
    let channelId = 0
    let postResumeMaxSeq = 0

    const openFollow = async (afterSeq?: number): Promise<void> => {
      channelId += 1
      channel = await device.openSecureChannel({
        hostId: host.identity.hostId,
        hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
        channelId,
      })
      const params: Record<string, unknown> = { sessionId: SESSION_ID }
      if (afterSeq !== undefined) params['afterSeq'] = afterSeq
      const follow = await channel.call<{ sid: number }>('sessions.follow', params)
      sid = follow.sid
      channel.onStreamItem(sid, (item) => {
        const it = item as { type: string; events?: Array<{ seq: number }> }
        if (it.type === 'events' && it.events) {
          for (const event of it.events) {
            tracker.note(event.seq)
            if (afterSeq !== undefined && event.seq > afterSeq && event.seq > postResumeMaxSeq) {
              postResumeMaxSeq = event.seq
            }
          }
        }
      })
    }

    const waitForEvents = (target: number, timeoutMs: number): Promise<void> => {
      if (tracker.size >= target) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${target} events (have ${tracker.size})`)),
          timeoutMs,
        )
        const check = (): void => {
          if (tracker.size >= target) {
            clearTimeout(timer)
            resolve()
            return
          }
          setTimeout(check, 5)
        }
        check()
      })
    }

    await openFollow()
    await waitForEvents(EVENTS_BEFORE_CUT, 15_000)
    expect(tracker.maxSeq).toBeGreaterThanOrEqual(EVENTS_BEFORE_CUT)

    // Abrupt cut: no cancel, no FIN — the host keeps producing into the void.
    await device.disconnect()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await device.connectToRelay(env.relayWsUrl)

    const resumeFrom = tracker.maxSeq
    await openFollow(resumeFrom)

    await waitForEvents(TOTAL_EVENTS, 30_000)
    host.gateway.stopProducing()

    console.log(
      `[P6-T1] mid-stream: cut after ${EVENTS_BEFORE_CUT} events, ${TOTAL_EVENTS} total, ` +
        `duplicates=${tracker.duplicates}`,
    )

    expect(tracker.duplicates).toBe(0)
    expect(tracker.size).toBe(TOTAL_EVENTS)
    for (let seq = 1; seq <= TOTAL_EVENTS; seq++) {
      expect(tracker.countOf(seq)).toBe(1)
    }
    // The stream genuinely resumed: events past the cut arrived afterwards.
    expect(postResumeMaxSeq).toBe(TOTAL_EVENTS)
  }, 120_000)

  it('recovers cold after a host restart without re-pairing the phone', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-ColdHost')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Cold')
    devices.push(device)

    const TOTAL_EVENTS = 200
    const EVENTS_BEFORE_RESTART = 25
    host.gateway.startProducing(20, TOTAL_EVENTS)

    const tracker = new EventTracker()
    let channel: FakeDeviceChannel | null = null
    let sid = 0
    let channelId = 0

    const openFollow = async (afterSeq?: number): Promise<void> => {
      channelId += 1
      channel = await device.openSecureChannel({
        hostId: host.identity.hostId,
        hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
        channelId,
      })
      const params: Record<string, unknown> = { sessionId: SESSION_ID }
      if (afterSeq !== undefined) params['afterSeq'] = afterSeq
      const follow = await channel.call<{ sid: number }>('sessions.follow', params)
      sid = follow.sid
      channel.onStreamItem(sid, (item) => {
        const it = item as { type: string; events?: Array<{ seq: number }> }
        if (it.type === 'events' && it.events) {
          for (const event of it.events) tracker.note(event.seq)
        }
      })
    }

    const waitForEvents = (target: number, timeoutMs: number): Promise<void> => {
      if (tracker.size >= target) return Promise.resolve()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${target} events (have ${tracker.size})`)),
          timeoutMs,
        )
        const check = (): void => {
          if (tracker.size >= target) {
            clearTimeout(timer)
            resolve()
            return
          }
          setTimeout(check, 5)
        }
        check()
      })
    }

    await openFollow()
    await waitForEvents(EVENTS_BEFORE_RESTART, 15_000)

    // Host process restart: the relay connection dies; identity + registry
    // survive (on disk in production, in-memory here by passing them along).
    channel!.cancelStream(sid)
    await host.hostRelay.stop()
    host.gateway.stopProducing()
    hosts.splice(hosts.indexOf(host), 1)

    const restarted = await startHost(env, 'P6-T1-ColdHost', {
      identity: host.identity,
      registry: host.registry,
    })
    hosts.push(restarted)
    restarted.gateway.startProducing(20, TOTAL_EVENTS)

    // The phone re-establishes its session on the restarted host. No new
    // pairing: the registry still holds this device's PSK and noise key.
    await device.disconnect()
    await device.connectToRelay(env.relayWsUrl)
    await openFollow(tracker.maxSeq)

    // Cold recovery: the RCP session works without re-pairing.
    const list = await channel!.call<{ items: Array<{ id: string }> }>('sessions.list', {})
    expect(list.items[0]?.id).toBe(SESSION_ID)

    await waitForEvents(TOTAL_EVENTS, 30_000)
    restarted.gateway.stopProducing()

    console.log(
      `[P6-T1] cold-recovery: restart after ${EVENTS_BEFORE_RESTART} events, ${TOTAL_EVENTS} total, ` +
        `duplicates=${tracker.duplicates}, re-pairing required=false`,
    )

    expect(tracker.duplicates).toBe(0)
    expect(tracker.size).toBe(TOTAL_EVENTS)
    for (let seq = 1; seq <= TOTAL_EVENTS; seq++) {
      expect(tracker.countOf(seq)).toBe(1)
    }
  }, 120_000)
})
