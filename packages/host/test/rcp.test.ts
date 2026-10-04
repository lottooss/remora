import { MAX_RCP_MESSAGE_BYTES, RCP_ERROR_CODES, createRcpError } from '@remora/protocol'
import { describe, expect, it } from 'vitest'
import { RcpMethodError, RcpServer, type RcpContext } from '../src/rcp/index.ts'

const HOST_ID = 'h_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const DEVICE_A: RcpContext = { deviceId: 'd_device_a', channelId: 1 }
const DEVICE_B: RcpContext = { deviceId: 'd_device_b', channelId: 2 }

function createServer(now: () => number = () => Date.now()): RcpServer {
  return new RcpServer({
    hostId: HOST_ID,
    hostName: 'Test Host',
    runtimeProvider: {
      hello: () => ({
        os: 'linux', pathSeparator: '/', versions: { remora: '1.0.0-test', dsh: '0.0.0-test' },
        features: ['sessions', 'files', 'diffs.git'], roots: ['/test'],
        policy: { approvalBiometric: 'high', allowRemoteSessionStart: false },
      }),
      status: () => ({ agentsRunning: 2, keepAwake: true, dsh: { version: '0.0.0-test', profile: 'remora-test' } }),
    },
    now,
  })
}

/** Sends one envelope and returns the decoded reply (fails when dropped). */
async function send(server: RcpServer, ctx: RcpContext, message: Record<string, unknown>) {
  const response = await server.handleMessage(JSON.stringify(message), ctx)
  if (response === null) throw new Error(`message was dropped: ${JSON.stringify(message)}`)
  return JSON.parse(response)
}

async function request(
  server: RcpServer,
  ctx: RcpContext,
  id: number,
  m: string,
  p?: Record<string, unknown>,
) {
  return send(server, ctx, p === undefined ? { k: 'req', id, m } : { k: 'req', id, m, p })
}

describe('RcpServer', () => {
  it('answers hello with the host identity, capabilities, and limits', async () => {
    const res = await request(createServer(), DEVICE_A, 1, 'hello', { rcp: [1], app: { name: 'remora-testkit', version: '1.0.0-test' } })
    expect(res.k).toBe('res')
    expect(res.id).toBe(1)
    expect(res.ok).toBe(true)
    expect(res.r.host).toEqual({ id: HOST_ID, name: 'Test Host', os: 'linux', pathSeparator: '/', versions: { remora: '1.0.0-test', dsh: '0.0.0-test' } })
    expect(res.r.rcp).toBe(1)
    expect(res.r.features).toEqual(['sessions', 'files', 'diffs.git'])
    expect(res.r.policy).toEqual({ approvalBiometric: 'high', allowRemoteSessionStart: false })
    expect(res.r.limits).toEqual({ maxMessageBytes: MAX_RCP_MESSAGE_BYTES, maxStreams: 10 })
    expect(res.r.roots).toEqual(['/test'])
  })

  it('answers ping with the echoed t and the host clock', async () => {
    const server = createServer(() => 1_700_000_000_000)
    const res = await request(server, DEVICE_A, 7, 'ping', { t: 1234 })
    expect(res.ok).toBe(true)
    expect(res.r).toEqual({ t: 1234, hostTime: 1_700_000_000_000 })
  })

  it('fails ping closed when params.t is missing or not a number', async () => {
    const res = await request(createServer(), DEVICE_A, 8, 'ping', { t: 'now' })
    expect(res.ok).toBe(false)
    expect(res.e.code).toBe(RCP_ERROR_CODES.invalid_params)
  })

  it('answers host.status from the status provider', async () => {
    let clock = 1_000
    const server = createServer(() => clock)
    clock = 6_000
    const res = await request(server, DEVICE_A, 3, 'host.status')
    expect(res.ok).toBe(true)
    expect(res.r).toEqual({ agentsRunning: 2, keepAwake: true, uptimeMs: 5_000, dsh: { version: '0.0.0-test', profile: 'remora-test' } })
  })

  it('answers method_not_found for methods without a handler', async () => {
    const res = await request(createServer(), DEVICE_A, 4, 'devices.list')
    expect(res.ok).toBe(false)
    expect(res.e.code).toBe(RCP_ERROR_CODES.method_not_found)
    expect(res.e.message).toContain('devices.list')
  })

  it('maps handler failures to safe RCP errors', async () => {
    const server = createServer()
    server.registerMethod('diffs.status', async () => {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.not_found, 'session is gone'))
    })
    server.registerMethod('fs.browse', async () => {
      throw new Error('C:\\Users\\secret\\path exploded')
    })

    const domain = await request(server, DEVICE_A, 1, 'diffs.status', {})
    expect(domain.ok).toBe(false)
    expect(domain.e.code).toBe(RCP_ERROR_CODES.not_found)
    expect(domain.e.message).toBe('session is gone')

    const crash = await request(server, DEVICE_A, 2, 'fs.browse', {})
    expect(crash.ok).toBe(false)
    expect(crash.e.code).toBe(RCP_ERROR_CODES.internal_error)
    expect(crash.e.message).not.toContain('secret')
    expect(crash.e.message).not.toContain('C:\\')
  })

  it('rate limits one device at 20 requests per second, then refills', async () => {
    let clock = 5_000
    const server = createServer(() => clock)

    for (let id = 1; id <= 20; id += 1) {
      const ok = await request(server, DEVICE_A, id, 'ping', { t: id })
      expect(ok.ok).toBe(true)
    }

    const limited = await request(server, DEVICE_A, 21, 'ping', { t: 21 })
    expect(limited.ok).toBe(false)
    expect(limited.e.code).toBe(RCP_ERROR_CODES.rate_limited)
    expect(limited.e.retryAfterMs).toBeGreaterThan(0)

    // Limits are per device: another device still has its own budget.
    const other = await request(server, DEVICE_B, 1, 'ping', { t: 1 })
    expect(other.ok).toBe(true)

    // Time refill restores the bucket.
    clock = 6_000
    const afterRefill = await request(server, DEVICE_A, 22, 'ping', { t: 22 })
    expect(afterRefill.ok).toBe(true)
  })

  it('opens a stream, hands out sid, and releases it on cancel', async () => {
    const server = createServer()
    server.registerMethod('sessions.follow', async () => ({}))

    const opened = await request(server, DEVICE_A, 1, 'sessions.follow', { sessionId: 's_1' })
    expect(opened.ok).toBe(true)
    const sid = opened.r.sid
    expect(typeof sid).toBe('number')
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(1)
    expect(server.getStream(sid)?.method).toBe('sessions.follow')

    const stream = server.getStream(sid)
    expect(stream?.signal.aborted).toBe(false)

    // Another device cannot cancel a stream it does not own.
    const foreign = await server.handleMessage(JSON.stringify({ k: 'cancel', sid }), DEVICE_B)
    expect(foreign).toBeNull()
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(1)
    expect(stream?.signal.aborted).toBe(false)

    const cancelled = await server.handleMessage(JSON.stringify({ k: 'cancel', sid }), DEVICE_A)
    expect(cancelled).toBeNull()
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(0)
    expect(server.getStream(sid)).toBeUndefined()
    expect(stream?.signal.aborted).toBe(true)
  })

  it('caps concurrent streams at 10 per device', async () => {
    const server = createServer()
    server.registerMethod('sessions.follow', async () => ({}))

    for (let id = 1; id <= 10; id += 1) {
      const opened = await request(server, DEVICE_A, id, 'sessions.follow', { sessionId: 's_1' })
      expect(opened.ok).toBe(true)
    }

    const rejected = await request(server, DEVICE_A, 11, 'sessions.follow', { sessionId: 's_1' })
    expect(rejected.ok).toBe(false)
    expect(rejected.e.code).toBe(RCP_ERROR_CODES.rate_limited)
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(10)
  })

  it('releases the streams of a device when its channel closes', async () => {
    const server = createServer()
    server.registerMethod('sessions.follow', async () => ({}))

    await request(server, DEVICE_A, 1, 'sessions.follow', { sessionId: 's_1' })
    server.closeChannel(DEVICE_B.deviceId, DEVICE_B.channelId)
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(1)

    server.closeChannel(DEVICE_A.deviceId, DEVICE_A.channelId)
    expect(server.activeStreamCount(DEVICE_A.deviceId)).toBe(0)
  })

  it('drops unparseable messages and answers envelopes it can identify', async () => {
    const server = createServer()

    expect(await server.handleMessage('not json', DEVICE_A)).toBeNull()
    expect(await server.handleMessage('{"k":"evt"}', DEVICE_A)).toBeNull()

    const invalid = await request(server, DEVICE_A, 9, '')
    expect(invalid.ok).toBe(false)
    expect(invalid.e.code).toBe(RCP_ERROR_CODES.invalid_request)
    expect(invalid.id).toBe(9)
  })

  it('rejects oversized messages with too_large', async () => {
    const server = createServer()
    const huge = JSON.stringify({
      k: 'req',
      id: 3,
      m: 'ping',
      p: { t: 1, pad: 'x'.repeat(MAX_RCP_MESSAGE_BYTES) },
    })

    const response = await server.handleMessage(huge, DEVICE_A)
    if (response === null) throw new Error('oversized message must be answered with too_large')
    const res = JSON.parse(response)
    expect(res.ok).toBe(false)
    expect(res.e.code).toBe(RCP_ERROR_CODES.too_large)
  })
})
