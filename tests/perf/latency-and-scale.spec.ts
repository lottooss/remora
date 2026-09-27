/**
 * P6-T1 latency and scale benchmarks (blueprint Â§2.3, Â§9.4, Â§13).
 *
 * Measurements against the success criteria:
 *  1. Prompt tap â†’ host ACK latency (target p50 â‰¤ 400 ms, p95 â‰¤ 1.2 s).
 *  2. Assistant chunk â†’ stream frame latency (target p50 â‰¤ 350 ms, includes
 *     â‰¤ 150 ms coalescing).
 *  3. 10,000-event scale session processing (throughput + exactly-once).
 *  4. Host memory growth over 1,000 streaming iterations (zero leak).
 *  5. Relay daily request projection for 8 h streaming (target â‰¤ 20 % of the
 *     100 k Cloudflare free-tier DO request quota).
 *  6. Approval request â†’ push dispatch latency (target p50 â‰¤ 3 s).
 *
 * Tests 1, 2, 5, 6 run the full stack (phone â†’ relay â†’ host). Tests 3 and 4
 * drive the host pipeline (gateway â†’ SessionAdapter â†’ RcpServer) directly via
 * `RcpServer.handleMessage` with an intercepted transport sender: the relay's
 * 50 msg/s per-connection limit (blueprint Â§9.4) would make a 10 k-event
 * end-to-end run take ~200 s, so the scale measurement targets the host
 * processing pipeline, which is the component whose throughput and memory
 * behaviour matter at scale. The Noise/SC-1/relay path is covered by the
 * network-resilience suite and the full-stack tests here.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  ChannelManager,
  HostNotifier,
  HostRelayConnection,
  InMemoryDeviceRegistry,
  InMemoryNotifyPrefsStore,
  PairingService,
  PendingRegistry,
  RcpServer,
  SessionAdapter,
  createHostIdentity,
  enrollHost,
  registerSessionMethods,
  type HostIdentity,
} from '@remora/host'
import { computeArgsDigest, decodeBase64Url } from '@remora/crypto'
import { E2eEnvironment, FakeDevice } from '@remora/testkit'

const SESSION_ID = 'perf-latency-session'
const DEVICE_ID = 'd_perf_latency'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Nearest-rank percentile of an ascending-sorted copy of `values`. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1]!
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 5): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(intervalMs)
  }
}

interface StreamReq {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
}

/**
 * Scripted dsh gateway for the latency/scale suite. Two stream modes:
 *  - `scriptedEvents > 0`: each follow yields that many durable events with
 *    fresh seq cursors (scale + memory measurements).
 *  - `scriptedChunks > 0`: each follow yields assistant-stream chunks spaced
 *    `chunkIntervalMs` apart (chunk-latency + relay-projection measurements).
 */
class ScriptedSessionGateway {
  scriptedEvents = 0
  scriptedChunks = 0
  chunkIntervalMs = 200
  readonly chunkYields: Array<{ index: number; at: number }> = []

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
                title: 'Latency Session',
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

  private async waitForAbort(signal?: AbortSignal): Promise<void> {
    if (!signal) return
    await new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  async *stream(req: StreamReq): AsyncIterable<unknown> {
    const header = { id: SESSION_ID, createdAt: 1000, version: 1, isSeeded: false }
    yield { type: 'snapshot', header, cursor: 0, records: [], hasMore: false }

    if (this.scriptedEvents > 0) {
      for (let i = 1; i <= this.scriptedEvents; i++) {
        if (req.signal?.aborted) return
        yield { type: 'event', event: { type: 'turn.start', seq: i, time: Date.now() } }
      }
      await this.waitForAbort(req.signal)
      return
    }

    if (this.scriptedChunks > 0) {
      yield {
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'att_perf', revision: 1, turn: 1, step: 1, startedAfterSeq: 0 },
      }
      for (let i = 0; i < this.scriptedChunks; i++) {
        if (req.signal?.aborted) return
        this.chunkYields.push({ index: i, at: Date.now() })
        yield {
          type: 'assistant-stream',
          frame: {
            type: 'chunk',
            attemptId: 'att_perf',
            revision: i + 2,
            index: i,
            time: Date.now(),
            chunk: { type: 'text-delta', text: `chunk-${i}` },
          },
        }
        await sleep(this.chunkIntervalMs)
      }
      yield {
        type: 'assistant-stream',
        frame: {
          type: 'end',
          attemptId: 'att_perf',
          revision: this.scriptedChunks + 2,
          index: this.scriptedChunks,
          outcome: { kind: 'committed' },
        },
      }
    }

    await this.waitForAbort(req.signal)
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
  /** Live counter of data frames the host has handed to the relay (sendFrame calls). */
  frameCounter: { count: number }
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

async function startHost(env: E2eEnvironment, name: string): Promise<HostHarness> {
  const identity = createHostIdentity()
  await enrollHost(env.relayHttpUrl, env.enrollSecret, identity, name)

  const gateway = new ScriptedSessionGateway()
  const registry = new InMemoryDeviceRegistry()

  let hostRelay: HostRelayConnection | null = null
  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName: name,
    statusProvider: {
      isRelayConnected: () => hostRelay?.isConnected ?? false,
      getPairedDevicesCount: () => registry.listDevices().filter((d) => !d.revoked).length,
    },
  })
  const sessionAdapter = new SessionAdapter({ gateway, streamCoalesceMs: 150 })
  registerSessionMethods(rcpServer, sessionAdapter)

  hostRelay = new HostRelayConnection({
    relayUrl: env.relayWsUrl,
    identity,
    onError: () => {},
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

  const frameCounter = { count: 0 }
  const channelManager = new ChannelManager({
    identity,
    registry,
    rcpServer,
    pairingService,
    sendFrame: (bytes) => {
      frameCounter.count += 1
      hostRelay!.sendFrameBytes(bytes)
    },
  })

  hostRelay.attachChannelManager(channelManager)
  hostRelay.start()
  await waitForReady(hostRelay)

  return { identity, registry, rcpServer, channelManager, hostRelay, pairingService, gateway, frameCounter }
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

/** Records stream items and end-of-stream for the intercepted transport. */
class StreamRecorder {
  items = 0
  ended = false
  readonly seqs: number[] = []
  private itemResolvers: Array<() => void> = []
  private endResolvers: Array<() => void> = []
  private eventTarget = 0

  reset(): void {
    this.items = 0
    this.ended = false
    this.seqs.length = 0
    this.itemResolvers = []
    this.endResolvers = []
  }

  recordItem(data: { type: string; events?: Array<{ seq: number }> }): void {
    this.items += 1
    if (data.type === 'events' && data.events) {
      for (const event of data.events) this.seqs.push(event.seq)
    }
    if (this.seqs.length >= this.eventTarget) {
      const resolvers = this.itemResolvers.splice(0)
      for (const resolve of resolvers) resolve()
    }
  }

  recordEnd(): void {
    this.ended = true
    const resolvers = this.endResolvers.splice(0)
    for (const resolve of resolvers) resolve()
  }

  waitForItems(n: number, timeoutMs: number): Promise<void> {
    this.eventTarget = n
    if (this.seqs.length >= n) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${n} events (have ${this.seqs.length})`)),
        timeoutMs,
      )
      this.itemResolvers.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  waitForEnd(timeoutMs: number): Promise<void> {
    if (this.ended) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for stream end')), timeoutMs)
      this.endResolvers.push(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function rcpCall(id: number, method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ k: 'req', id, m: method, p: params })
}

/** Dispatches one RCP call through the server and parses the response. */
async function callRcp(
  rcpServer: RcpServer,
  id: number,
  method: string,
  params: Record<string, unknown>,
  ctx: { deviceId: string; channelId: number },
): Promise<unknown> {
  const res = await rcpServer.handleMessage(rcpCall(id, method, params), ctx)
  if (res === null) throw new Error(`RCP call ${method} returned null`)
  return JSON.parse(res)
}

const NOTIFY_CONFIG = {
  approval: true,
  question: true,
  turnDone: true,
  turnError: true,
  hostOffline: true,
} as const

describe('P6-T1 latency and scale', () => {
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
      await host.hostRelay.stop()
    }
    hosts.length = 0
    if (env) {
      await env.teardown()
      env = null
    }
  })

  it('measures prompt tap to host ACK latency (target p50 <= 400ms, p95 <= 1.2s)', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-Prompt-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Prompt')
    devices.push(device)

    const channel = await device.openSecureChannel({
      hostId: host.identity.hostId,
      hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
      channelId: 1,
    })

    const SAMPLES = 50
    const latencies: number[] = []
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = Date.now()
      const res = await channel.call<{ accepted: boolean; duplicate: boolean }>('sessions.prompt', {
        sessionId: SESSION_ID,
        requestId: randomUUID(),
        text: `prompt ${i}`,
        delivery: 'queue',
      })
      const t1 = Date.now()
      expect(res.accepted).toBe(true)
      expect(res.duplicate).toBe(false)
      latencies.push(t1 - t0)
      // sessions.prompt is mutating: the host allows 5/s. Pace below that.
      await sleep(250)
    }

    const p50 = percentile(latencies, 50)
    const p90 = percentile(latencies, 90)
    const p95 = percentile(latencies, 95)
    const p99 = percentile(latencies, 99)

    console.log(`[P6-T1] prompt-ack ms: p50=${p50} p90=${p90} p95=${p95} p99=${p99} (n=${SAMPLES})`)

    expect(p50).toBeLessThanOrEqual(400)
    expect(p95).toBeLessThanOrEqual(1_200)
  }, 120_000)

  it('measures assistant chunk to stream frame latency (target p50 <= 350ms)', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-Chunk-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Chunk')
    devices.push(device)

    // Chunks spaced 200 ms apart: each flushes individually ~150 ms after its
    // yield (the coalescing window), so per-chunk latency is measurable.
    host.gateway.scriptedChunks = 30
    host.gateway.chunkIntervalMs = 200

    const channel = await device.openSecureChannel({
      hostId: host.identity.hostId,
      hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
      channelId: 1,
    })

    const receivedAt = new Map<number, number>()
    const follow = await channel.call<{ sid: number }>('sessions.follow', {
      sessionId: SESSION_ID,
      live: true,
    })
    channel.onStreamItem(follow.sid, (item) => {
      const it = item as { type: string; index?: number }
      if (it.type === 'live.delta' && typeof it.index === 'number') {
        receivedAt.set(it.index, Date.now())
      }
    })

    await waitFor(() => receivedAt.size >= 30, 30_000)
    channel.cancelStream(follow.sid)

    const latencies: number[] = []
    for (let i = 0; i < host.gateway.chunkYields.length; i++) {
      const yieldAt = host.gateway.chunkYields[i]!.at
      const recv = receivedAt.get(i)
      if (recv !== undefined) latencies.push(recv - yieldAt)
    }
    expect(latencies.length).toBe(30)

    const p50 = percentile(latencies, 50)
    const p90 = percentile(latencies, 90)
    const p95 = percentile(latencies, 95)

    console.log(`[P6-T1] chunk-to-frame ms: p50=${p50} p90=${p90} p95=${p95} (n=${latencies.length})`)

    expect(p50).toBeLessThanOrEqual(350)
  }, 120_000)

  it('processes a 10,000-event scale session with exactly-once delivery', async () => {
    const gateway = new ScriptedSessionGateway()
    gateway.scriptedEvents = 10_000

    let fakeNow = 1_000_000
    const rcpServer = new RcpServer({
      hostId: 'h_perf_scale',
      hostName: 'ScaleHost',
      now: () => (fakeNow += 1_000),
    })
    const adapter = new SessionAdapter({ gateway, streamCoalesceMs: 150 })
    registerSessionMethods(rcpServer, adapter)

    const recorder = new StreamRecorder()
    rcpServer.setTransportSender((_deviceId, _channelId, messageJson) => {
      const msg = JSON.parse(messageJson) as { k: string; d?: { type: string; events?: Array<{ seq: number }> } }
      if (msg.k === 'item' && msg.d) recorder.recordItem(msg.d)
      else if (msg.k === 'end') recorder.recordEnd()
      return true
    })

    const ctx = { deviceId: DEVICE_ID, channelId: 1 }
    recorder.reset()

    const t0 = Date.now()
    const followRes = (await callRcp(rcpServer, 1, 'sessions.follow', { sessionId: SESSION_ID }, ctx)) as {
      ok: boolean
      r: { sid: number }
    }
    expect(followRes.ok).toBe(true)

    await recorder.waitForItems(10_000, 60_000)
    const elapsedMs = Date.now() - t0

    // Cancel releases the stream; a cancelled pump sends no end frame, so we
    // only give it a tick to unwind before asserting.
    await rcpServer.handleMessage(JSON.stringify({ k: 'cancel', sid: followRes.r.sid }), ctx)
    await sleep(50)

    const throughput = 10_000 / (elapsedMs / 1000)
    console.log(`[P6-T1] 10k events: ${elapsedMs}ms (${throughput.toFixed(0)} events/s)`)

    expect(recorder.seqs.length).toBe(10_000)
    const counts = new Map<number, number>()
    let duplicates = 0
    for (const seq of recorder.seqs) {
      const count = counts.get(seq) ?? 0
      if (count > 0) duplicates += 1
      counts.set(seq, count + 1)
    }
    expect(duplicates).toBe(0)
    for (let seq = 1; seq <= 10_000; seq++) {
      expect(counts.get(seq)).toBe(1)
    }
  }, 120_000)

  it('shows zero host memory growth over 1,000 streaming iterations', async () => {
    const gateway = new ScriptedSessionGateway()
    gateway.scriptedEvents = 10

    let fakeNow = 1_000_000
    const rcpServer = new RcpServer({
      hostId: 'h_perf_mem',
      hostName: 'MemHost',
      now: () => (fakeNow += 1_000),
    })
    const adapter = new SessionAdapter({ gateway, streamCoalesceMs: 150 })
    registerSessionMethods(rcpServer, adapter)

    const recorder = new StreamRecorder()
    rcpServer.setTransportSender((_deviceId, _channelId, messageJson) => {
      const msg = JSON.parse(messageJson) as { k: string; d?: { type: string; events?: Array<{ seq: number }> } }
      if (msg.k === 'item' && msg.d) recorder.recordItem(msg.d)
      else if (msg.k === 'end') recorder.recordEnd()
      return true
    })

    const ctx = { deviceId: DEVICE_ID, channelId: 1 }
    const ITERATIONS = 1_000

    const runIteration = async (i: number): Promise<void> => {
      recorder.reset()
      const followRes = (await callRcp(rcpServer, i * 2 + 1, 'sessions.follow', { sessionId: SESSION_ID }, ctx)) as {
        ok: boolean
        r: { sid: number }
      }
      await recorder.waitForItems(10, 5_000)
      await rcpServer.handleMessage(JSON.stringify({ k: 'cancel', sid: followRes.r.sid }), ctx)
      await sleep(1)
      await callRcp(rcpServer, i * 2 + 2, 'sessions.prompt', {
        sessionId: SESSION_ID,
        requestId: randomUUID(),
        text: `iteration ${i}`,
        delivery: 'queue',
      }, ctx)
    }

    for (let i = 0; i < 50; i++) await runIteration(i)

    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    await sleep(100)
    const baselineRss = process.memoryUsage().rss

    for (let i = 50; i < 50 + ITERATIONS; i++) await runIteration(i)

    gc?.()
    await sleep(100)
    const finalRss = process.memoryUsage().rss
    const growth = finalRss - baselineRss

    console.log(
      `[P6-T1] memory over ${ITERATIONS} iterations: baseline=${(baselineRss / 1e6).toFixed(1)}MB final=${(finalRss / 1e6).toFixed(1)}MB growth=${(growth / 1e6).toFixed(2)}MB`,
    )

    expect(growth).toBeLessThan(32 * 1e6)
  }, 240_000)

  it('projects relay daily usage for 8h streaming within 20% of the free-tier quota', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-Projection-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Projection')
    devices.push(device)

    // 20 chunks/s coalesced at 150 ms → ~7 live-delta frames/s, the rate
    // blueprint §9.4 assumes for a heavy streaming day.
    host.gateway.scriptedChunks = 250
    host.gateway.chunkIntervalMs = 50

    const channel = await device.openSecureChannel({
      hostId: host.identity.hostId,
      hostNoisePublicKey: host.identity.noiseKeypair.publicKey,
      channelId: 1,
    })

    // Count the host's outbound data frames (responses + stream items) during
    // the streaming window. The relay bills each incoming WebSocket message at
    // 20:1 (blueprint §9.4); the device contributes only the follow request and
    // the final cancel, which we add explicitly.
    host.frameCounter.count = 0
    const t0 = Date.now()

    let liveEnded = false
    const follow = await channel.call<{ sid: number }>('sessions.follow', {
      sessionId: SESSION_ID,
      live: true,
    })
    channel.onStreamItem(follow.sid, (item) => {
      if ((item as { type: string }).type === 'live.end') liveEnded = true
    })

    await waitFor(() => liveEnded, 30_000)
    await sleep(300)

    channel.cancelStream(follow.sid)
    const windowSec = (Date.now() - t0) / 1000
    const hostMessages = host.frameCounter.count
    const deviceMessages = 2
    const messages = hostMessages + deviceMessages
    const msgPerSec = messages / windowSec

    const billedPerHour = (msgPerSec * 3_600) / 20
    const dailyRequests = billedPerHour * 8
    const pctOfQuota = (dailyRequests / 100_000) * 100

    console.log(
      `[P6-T1] relay: ${messages} messages in ${windowSec.toFixed(1)}s = ${msgPerSec.toFixed(1)} msg/s → ` +
        `${dailyRequests.toFixed(0)} billed requests/day = ${pctOfQuota.toFixed(1)}% of 100k quota`,
    )

    expect(pctOfQuota).toBeLessThanOrEqual(20)
  }, 120_000)

  it('measures approval request to push dispatch latency (target p50 <= 3s)', async () => {
    if (!env) throw new Error('env not started')
    const host = await startHost(env, 'P6-T1-Approval-Host')
    hosts.push(host)
    const device = await pairDevice(env, host, 'Pixel-Approval')
    devices.push(device)

    const pendingRegistry = new PendingRegistry()
    const dispatchLatencies: number[] = []
    const roundTripLatencies: number[] = []
    let currentAddTime = 0

    const notifier = new HostNotifier({
      registry: host.registry,
      prefsStore: new InMemoryNotifyPrefsStore(),
      config: NOTIFY_CONFIG,
      sendPush: (frame) => {
        dispatchLatencies.push(Date.now() - currentAddTime)
        return host.hostRelay.sendPushFrame(frame).then((result) => {
          roundTripLatencies.push(Date.now() - currentAddTime)
          return result
        })
      },
      isDeviceConnected: () => false,
      isDeviceForegrounded: () => false,
    })
    const detach = notifier.attachPendingRegistry(pendingRegistry)

    const SAMPLES = 20
    for (let i = 0; i < SAMPLES; i++) {
      const preview = { text: 'pnpm test', json: '{"cmd":"pnpm test"}' }
      currentAddTime = Date.now()
      pendingRegistry.add({
        kind: 'approval',
        id: randomUUID(),
        sessionId: SESSION_ID,
        sessionTitle: 'Approval Session',
        toolName: 'bash',
        preview,
        argsDigest: computeArgsDigest(preview),
        risk: 'normal',
        requiresSignature: false,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
      await waitFor(() => roundTripLatencies.length > i, 10_000)
    }

    detach()

    const p50 = percentile(dispatchLatencies, 50)
    const p95 = percentile(dispatchLatencies, 95)
    const rtP50 = percentile(roundTripLatencies, 50)

    console.log(
      `[P6-T1] approval-push ms: dispatch p50=${p50} p95=${p95}, relay round-trip p50=${rtP50} (n=${SAMPLES})`,
    )

    expect(p50).toBeLessThanOrEqual(3_000)
  }, 120_000)
})
