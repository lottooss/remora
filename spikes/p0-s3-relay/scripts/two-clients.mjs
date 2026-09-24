#!/usr/bin/env node
/**
 * P0-S3 two-client measurement script for the RLY/1 spike relay.
 *
 * Connects a Host and a Phone endpoint (HMAC challenge auth), then runs phases:
 *   rtt         — control-ping (auto-response) and data-frame echo round-trips
 *   throughput  — 10,000 binary frames (sizes across 64 B–64 KiB), both
 *                 directions, verifying sequential ordering + pattern integrity
 *   oversize    — a 65,537-byte frame must be rejected with error{too_large}
 *   keepalive   — 50 auto-response pings; DO ws_msg_in counter must not move
 *   replace     — second connection for the same id closes the first with 4409
 *   hibernate   — idle past the 10 s hibernation threshold; constructor re-runs
 *                 (wakes++), attachments survive, routing still works
 *   alarm       — host disconnect arms the alarm; reconnect cancels it; the
 *                 second disconnect lets it fire → spike.host_offline to the phone
 *
 * Usage: node scripts/two-clients.mjs [--url http://127.0.0.1:8787]
 *   [--frames 10000] [--rtt 200] [--idle-ms 15000]
 *   [--phase all|rtt,throughput,oversize,keepalive,replace,hibernate,alarm]
 */
import { createHmac } from 'node:crypto'

// ---------------------------------------------------------------------------
// Config (SPIKE_AUTH_KEY must match wrangler.toml — demo key, not a secret)
// ---------------------------------------------------------------------------
const AUTH_KEY = 'remora-p0-s3-demo-not-a-secret'
const HEADER = 28
const PING = '{"t":"ping"}'
const HOST_ID = 'h_spikehost01'
const DEV_ID = 'd_spikephone1'
const REPLACE_ID = 'h_spikerepl1'
const CH_BULK = 1
const CH_RTT = 2
const CH_PROBE = 3
const KIND_BYTE = { host: 0x01, device: 0x02 }

const ALL_PHASES = ['rtt', 'throughput', 'oversize', 'keepalive', 'replace', 'hibernate', 'alarm']

function parseArgs(argv) {
  const out = { url: 'http://127.0.0.1:8787', frames: 10000, rtt: 200, idleMs: 15000, alertMs: 5000, phase: 'all' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === '--url') out.url = next()
    else if (a === '--frames') out.frames = Number(next())
    else if (a === '--rtt') out.rtt = Number(next())
    else if (a === '--idle-ms') out.idleMs = Number(next())
    else if (a === '--alert-ms') out.alertMs = Number(next())
    else if (a === '--phase') out.phase = next()
    else if (a === '--help' || a === '-h') {
      console.log('see header of scripts/two-clients.mjs for usage')
      process.exit(0)
    } else throw new Error(`unknown arg ${a}`)
  }
  if (!Number.isFinite(out.frames) || out.frames < 2) throw new Error('--frames must be >= 2')
  if (!Number.isFinite(out.rtt) || out.rtt < 1) throw new Error('--rtt must be >= 1')
  if (!Number.isFinite(out.idleMs) || out.idleMs < 11000) throw new Error('--idle-ms must be >= 11000 (hibernation threshold is 10 s)')
  if (!Number.isFinite(out.alertMs) || out.alertMs < 1000) throw new Error('--alert-ms must be >= 1000 (wrangler.toml HOST_OFFLINE_ALERT_MS=5000)')
  return out
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const passes = []
const notes = []

/** Keep abandoned waiters from triggering unhandledRejection; awaiters still see the error. */
function guard(p) {
  p.catch(() => {})
  return p
}

function ok(msg) {
  passes.push(msg)
  console.log(`PASS  ${msg}`)
}
function note(msg) {
  notes.push(msg)
  console.log(`NOTE  ${msg}`)
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
function toBuffer(data) {
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(data)
}
function percentile(sorted, p) {
  if (sorted.length === 0) return NaN
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}
function stats(lats) {
  const s = [...lats].sort((a, b) => a - b)
  const mean = s.reduce((acc, v) => acc + v, 0) / s.length
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    max: s[s.length - 1],
    mean,
  }
}
function fmtStats(st) {
  return `n=${st.n} min=${st.min.toFixed(2)}ms p50=${st.p50.toFixed(2)}ms p95=${st.p95.toFixed(2)}ms max=${st.max.toFixed(2)}ms mean=${st.mean.toFixed(2)}ms`
}
function miB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1)
}

// ---------------------------------------------------------------------------
// Frame codec (spike dialect of RLY/1 §6: ASCII id in the 16-byte peer field)
// ---------------------------------------------------------------------------
function encodeFrame({ channel, dstKind, dstId, seq, payloadLen }) {
  const buf = new Uint8Array(HEADER + payloadLen)
  buf[0] = 0x01
  buf[1] = 0x01
  buf[2] = 0x00
  buf[3] = 0x00
  new DataView(buf.buffer).setUint32(4, channel, false)
  buf[8] = dstKind
  const enc = new TextEncoder().encode(dstId)
  if (enc.length > 16) throw new Error('dstId too long for spike peer field')
  buf.set(enc, 9)
  const dv = new DataView(buf.buffer)
  dv.setUint32(HEADER, seq, false)
  for (let i = 4; i < payloadLen; i++) buf[HEADER + i] = (seq + i * 7) & 0xff
  return buf
}

function parseFrame(buf) {
  if (buf.length < HEADER) throw new Error(`frame ${buf.length} B < header`)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf[0] !== 0x01 || buf[1] !== 0x01 || buf[2] !== 0 || buf[3] !== 0) throw new Error('bad frame prefix')
  const channel = dv.getUint32(4, false)
  const srcKind = buf[8]
  let end = buf.indexOf(0, 9)
  if (end < 0) end = 25
  const srcId = new TextDecoder().decode(buf.subarray(9, end))
  const seq = dv.getUint32(HEADER, false)
  return { channel, srcKind, srcId, seq, payloadLen: buf.length - HEADER }
}

function verifyPattern(buf, seq, payloadLen) {
  for (let i = 4; i < payloadLen; i++) {
    const want = (seq + i * 7) & 0xff
    if (buf[HEADER + i] !== want) throw new Error(`payload corrupt at ${i}: got ${buf[HEADER + i]} want ${want}`)
  }
}

function frameSizeFor(seq) {
  if (seq % 1000 === 999) return 65536
  if (seq % 997 === 996) return 64
  return 64 + ((Math.imul(seq + 1, 2654435761) >>> 0) % (65536 - 64 + 1))
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
class Client {
  constructor({ id, kind, name, baseUrl }) {
    this.id = id
    this.kind = kind
    this.name = name
    this.baseUrl = baseUrl
    this.ws = null
    this.challenge = null
    this.ready = null
    this.textWaiters = []
    this.closeWaiters = []
    this.binaryWaiters = []
    this.binaryHandler = null
    this.bufferedText = []
    this.bufferedBinary = []
    this.unexpectedBinary = 0
    this.closeInfo = null
  }

  get kindByte() {
    return KIND_BYTE[this.kind]
  }

  wsUrl() {
    const u = new URL('/v1/connect', this.baseUrl)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.searchParams.set('id', this.id)
    u.searchParams.set('kind', this.kind)
    u.searchParams.set('name', this.name)
    return u
  }

  async open(timeoutMs = 5000) {
    const ws = new WebSocket(this.wsUrl())
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data))
    ws.addEventListener('close', (ev) => this.#onClose(ev))
    ws.addEventListener('error', () => {
      /* close event follows */
    })
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.id}: open timeout`)), timeoutMs)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'close',
        (ev) => {
          clearTimeout(timer)
          reject(new Error(`${this.id}: closed with ${ev.code} before open`))
        },
        { once: true },
      )
    })
    this.challenge = await this.waitText((m) => m.t === 'challenge', timeoutMs)
  }

  async auth(timeoutMs = 5000) {
    const sig = createHmac('sha256', AUTH_KEY)
      .update(`${this.challenge.nonce}|${this.id}|${this.kind}`)
      .digest('base64url')
    const replyP = this.waitText((m) => m.t === 'ready' || m.t === 'error', timeoutMs)
    this.sendText(JSON.stringify({ t: 'auth', v: 1, kind: this.kind, id: this.id, sig }))
    const reply = await replyP
    assert(reply.t === 'ready', `${this.id}: auth rejected: ${JSON.stringify(reply)}`)
    this.ready = reply
  }

  #onMessage(data) {
    if (typeof data === 'string') {
      let msg = null
      try {
        msg = JSON.parse(data)
      } catch {
        this.bufferedText.push(data)
        return
      }
      const idx = this.textWaiters.findIndex((w) => w.predicate(msg))
      if (idx >= 0) {
        const [w] = this.textWaiters.splice(idx, 1)
        clearTimeout(w.timer)
        w.resolve(msg)
        return
      }
      this.bufferedText.push(msg)
      if (this.bufferedText.length > 100) this.bufferedText.shift()
      return
    }
    const buf = toBuffer(data)
    const idx = this.binaryWaiters.findIndex((w) => w.predicate(buf))
    if (idx >= 0) {
      const [w] = this.binaryWaiters.splice(idx, 1)
      clearTimeout(w.timer)
      w.resolve(buf)
      return
    }
    if (this.binaryHandler) {
      try {
        this.binaryHandler(buf)
      } catch (e) {
        this.binaryHandlerError = e
      }
      return
    }
    this.unexpectedBinary += 1
    this.bufferedBinary.push(buf)
    if (this.bufferedBinary.length > 100) this.bufferedBinary.shift()
  }

  #onClose(ev) {
    this.closeInfo = { code: ev.code, reason: ev.reason, wasClean: ev.wasClean }
    for (const w of this.closeWaiters.splice(0)) {
      clearTimeout(w.timer)
      w.resolve(this.closeInfo)
    }
    const closeErr = new Error(`${this.id}: socket closed with ${ev.code} while waiting`)
    for (const w of this.textWaiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(closeErr)
    }
    for (const w of this.binaryWaiters.splice(0)) {
      clearTimeout(w.timer)
      w.reject(closeErr)
    }
  }

  waitText(predicate, timeoutMs = 5000) {
    const bufferedIdx = this.bufferedText.findIndex(predicate)
    if (bufferedIdx >= 0) {
      const [msg] = this.bufferedText.splice(bufferedIdx, 1)
      return Promise.resolve(msg)
    }
    if (this.closeInfo) return guard(Promise.reject(new Error(`${this.id}: socket closed ${this.closeInfo.code} while waiting for text`)))
    return guard(
      new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          const i = this.textWaiters.indexOf(waiter)
          if (i >= 0) this.textWaiters.splice(i, 1)
          reject(new Error(`${this.id}: text wait timeout`))
        }, timeoutMs)
        this.textWaiters.push(waiter)
      }),
    )
  }

  waitBinary(predicate, timeoutMs = 10000) {
    const bufferedIdx = this.bufferedBinary.findIndex(predicate)
    if (bufferedIdx >= 0) {
      const [buf] = this.bufferedBinary.splice(bufferedIdx, 1)
      return Promise.resolve(buf)
    }
    if (this.closeInfo) return guard(Promise.reject(new Error(`${this.id}: socket closed ${this.closeInfo.code} while waiting for binary`)))
    return guard(
      new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null }
        waiter.timer = setTimeout(() => {
          const i = this.binaryWaiters.indexOf(waiter)
          if (i >= 0) this.binaryWaiters.splice(i, 1)
          reject(new Error(`${this.id}: binary wait timeout`))
        }, timeoutMs)
        this.binaryWaiters.push(waiter)
      }),
    )
  }

  waitForClose(timeoutMs = 5000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo)
    return guard(
      new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null }
        waiter.timer = setTimeout(() => reject(new Error(`${this.id}: close wait timeout`)), timeoutMs)
        this.closeWaiters.push(waiter)
      }),
    )
  }

  sendText(str) {
    this.ws.send(str)
  }

  sendBinary(buf) {
    this.ws.send(buf)
  }

  close(code = 1000) {
    try {
      this.ws.close(code, 'bye')
    } catch {
      /* already closed */
    }
  }

  get isOpen() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }
}

async function connectEndpoint(cfg) {
  const c = new Client(cfg)
  await c.open()
  await c.auth()
  return c
}

// ---------------------------------------------------------------------------
// HTTP helpers against the spike Worker
// ---------------------------------------------------------------------------
async function getStats(base) {
  const res = await fetch(new URL('/v1/stats', base))
  if (!res.ok) throw new Error(`stats HTTP ${res.status}`)
  return res.json()
}

async function enroll(base, path, body) {
  const res = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`enroll ${path} HTTP ${res.status}: ${await res.text()}`)
  return res.json()
}

async function pollStats(base, pred, timeoutMs, label) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await getStats(base)
    if (pred(last)) return last
    await sleep(200)
  }
  throw new Error(`pollStats(${label}) timeout; last counters=${JSON.stringify(last && last.counters)}`)
}

function socketFor(statsObj, id) {
  return statsObj.sockets.find((s) => s.tags.includes(id))
}

function assertNoBufferedErrors(client, label) {
  const errs = client.bufferedText.filter((m) => typeof m === 'object' && m !== null && m.t === 'error')
  assert(errs.length === 0, `${label}: unexpected relay errors: ${JSON.stringify(errs.slice(0, 3))}`)
}

// ---------------------------------------------------------------------------
// Pump helper with basic client-side backpressure
// ---------------------------------------------------------------------------
async function pumpFrames(from, to, count, channel) {
  const t0 = performance.now()
  let bytes = 0
  for (let seq = 0; seq < count; seq++) {
    const size = frameSizeFor(seq)
    const frame = encodeFrame({
      channel,
      dstKind: to.kindByte,
      dstId: to.id,
      seq,
      payloadLen: size - HEADER,
    })
    from.sendBinary(frame)
    bytes += size
    if (from.ws.bufferedAmount > 8 * 1024 * 1024) {
      while (from.ws.bufferedAmount > 2 * 1024 * 1024) await sleep(5)
    }
    if (seq % 100 === 99) await new Promise((r) => setImmediate(r))
  }
  return { t0, bytes }
}

function makeBulkReceiver(channel, srcKind, srcId, count) {
  let expectedSeq = 0
  let bytes = 0
  let minSize = Infinity
  let maxSize = 0
  let done
  const donePromise = new Promise((resolve, reject) => {
    done = { resolve, reject }
  })
  guard(donePromise)
  const timer = setTimeout(() => done.reject(new Error(`bulk receive timeout at seq ${expectedSeq}/${count}`)), 120000)
  return {
    done: donePromise,
    handler(buf) {
      const f = parseFrame(buf)
      if (f.channel !== channel) throw new Error(`unexpected channel ${f.channel}`)
      if (f.srcKind !== KIND_BYTE[srcKind] || f.srcId !== srcId) {
        throw new Error(`bad source rewrite: kind=${f.srcKind} id=${f.srcId}`)
      }
      if (f.seq !== expectedSeq) throw new Error(`out of order: got ${f.seq} want ${expectedSeq}`)
      if (f.payloadLen < 4) throw new Error('payload too short')
      verifyPattern(buf, f.seq, f.payloadLen)
      expectedSeq += 1
      bytes += buf.length
      if (buf.length < minSize) minSize = buf.length
      if (buf.length > maxSize) maxSize = buf.length
      if (expectedSeq === count) {
        clearTimeout(timer)
        done.resolve()
      }
    },
    result() {
      return { count: expectedSeq, bytes, minSize, maxSize }
    },
  }
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
async function phaseRtt(ctx) {
  const { host, dev, cfg } = ctx
  // Control-plane ping: must be answered by setWebSocketAutoResponse.
  const control = []
  for (let i = 0; i < Math.min(cfg.rtt, 50); i++) {
    const t0 = performance.now()
    const pong = host.waitText((m) => m.t === 'pong', 5000)
    host.sendText(PING)
    await pong
    control.push(performance.now() - t0)
  }
  ok(`control ping auto-response RTT (${fmtStats(stats(control))})`)

  // Data-frame echo: full wake + route + rewrite both directions.
  // The device echoes CH_RTT frames back byte-for-byte (the relay rewrote the
  // peer field to the source on delivery, so re-sending addresses the echo home).
  dev.binaryHandler = (buf) => {
    const f = parseFrame(buf)
    if (f.channel !== CH_RTT) throw new Error(`device got unexpected channel ${f.channel}`)
    if (f.srcKind !== KIND_BYTE.host || f.srcId !== host.id) throw new Error(`device got bad source ${f.srcKind}/${f.srcId}`)
    verifyPattern(buf, f.seq, f.payloadLen)
    dev.sendBinary(buf)
  }
  const data = []
  let seq = 0
  try {
    for (let i = 0; i < cfg.rtt; i++) {
      const t0 = performance.now()
      const replyP = host.waitBinary((buf) => {
        try {
          return parseFrame(buf).channel === CH_RTT
        } catch {
          return false
        }
      }, 5000)
      const frame = encodeFrame({ channel: CH_RTT, dstKind: dev.kindByte, dstId: dev.id, seq, payloadLen: 996 })
      host.sendBinary(frame)
      const reply = await replyP
      const f = parseFrame(reply)
      assert(f.srcKind === KIND_BYTE.device && f.srcId === dev.id, `echo source rewrite wrong: ${JSON.stringify(f)}`)
      assert(f.seq === seq, `echo seq ${f.seq} != ${seq}`)
      verifyPattern(reply, f.seq, f.payloadLen)
      data.push(performance.now() - t0)
      seq += 1
    }
  } finally {
    dev.binaryHandler = null
    assert(dev.binaryHandlerError == null, `device echo error: ${dev.binaryHandlerError}`)
  }
  ok(`data frame echo RTT (${fmtStats(stats(data))})`)
  ctx.probeSeq = seq
}

async function phaseThroughput(ctx) {
  const { host, dev, cfg } = ctx
  const perDir = Math.floor(cfg.frames / 2)
  const dirs = [
    { from: host, to: dev, label: 'host→device' },
    { from: dev, to: host, label: 'device→host' },
  ]
  for (const d of dirs) {
    d.from.bufferedBinary.length = 0
    d.to.bufferedBinary.length = 0
    d.to.unexpectedBinary = 0
    d.to.binaryHandlerError = null
    const recv = makeBulkReceiver(CH_BULK, d.from.kind, d.from.id, perDir)
    d.to.binaryHandler = recv.handler
    const pump = await pumpFrames(d.from, d.to, perDir, CH_BULK)
    await recv.done
    const t1 = performance.now()
    d.to.binaryHandler = null
    const elapsed = (t1 - pump.t0) / 1000
    const r = recv.result()
    assert(d.to.binaryHandlerError === null, `${d.label}: receiver error: ${d.to.binaryHandlerError}`)
    assert(r.count === perDir, `${d.label}: received ${r.count}/${perDir}`)
    ok(
      `${d.label}: ${r.count} frames, ${miB(r.bytes)} MiB in ${elapsed.toFixed(2)}s → ` +
        `${Math.round(r.count / elapsed)} f/s, ${miB(r.bytes / elapsed)} MiB/s, ` +
        `sizes ${r.minSize}–${r.maxSize} B, order+integrity OK`,
    )
    assertNoBufferedErrors(d.from, d.label)
  }
}

async function phaseOversize(ctx) {
  const { host, dev } = ctx
  const errP = host.waitText((m) => m.t === 'error' && m.code === 'too_large', 5000)
  host.sendBinary(new Uint8Array(65537))
  const err = await errP
  ok(`65537-byte frame rejected: ${JSON.stringify(err)}`)
  // Connection must survive a dropped oversized frame.
  const t0 = performance.now()
  const pong = host.waitText((m) => m.t === 'pong', 5000)
  host.sendText(PING)
  await pong
  ok(`connection still usable after rejection (pong in ${(performance.now() - t0).toFixed(1)}ms)`)

  // not_linked: well-formed frame to an id that exists but has no link row.
  const notLinkedP = dev.waitText((m) => m.t === 'error' && m.code === 'not_linked', 5000)
  dev.sendBinary(
    encodeFrame({ channel: CH_PROBE, dstKind: KIND_BYTE.host, dstId: 'h_unlinked01', seq: 0, payloadLen: 996 }),
  )
  const notLinked = await notLinkedP
  ok(`frame to unlinked endpoint rejected: ${JSON.stringify(notLinked)}`)
}

async function phaseKeepalive(ctx) {
  const { host, base } = ctx
  const before = await getStats(base)
  const hostSockBefore = socketFor(before, host.id)
  assert(hostSockBefore !== undefined, 'host socket missing from stats')
  const lats = []
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now()
    const pong = host.waitText((m) => m.t === 'pong', 5000)
    host.sendText(PING)
    await pong
    lats.push(performance.now() - t0)
  }
  const after = await getStats(base)
  const hostSockAfter = socketFor(after, host.id)
  const msgDelta = after.counters.ws_msg_in - before.counters.ws_msg_in
  assert(msgDelta === 0, `ws_msg_in moved by ${msgDelta} during 50 auto-response pings`)
  ok(`50 auto-response pings, 0 DO wakeups (ws_msg_in delta=0), pong RTT (${fmtStats(stats(lats))})`)
  assert(
    hostSockAfter.lastAutoResponseAt !== null &&
      (hostSockBefore.lastAutoResponseAt === null || hostSockAfter.lastAutoResponseAt !== hostSockBefore.lastAutoResponseAt),
    'getWebSocketAutoResponseTimestamp did not advance',
  )
  ok(`auto-response timestamp advanced: ${hostSockBefore.lastAutoResponseAt ?? 'null'} → ${hostSockAfter.lastAutoResponseAt}`)
}

async function phaseReplace(ctx) {
  const { base } = ctx
  // Fail-closed auth first: a garbage signature must yield error + close 4401.
  const bad = new Client({ id: REPLACE_ID, kind: 'host', name: 'spike-badauth', baseUrl: base })
  await bad.open()
  const badErrP = bad.waitText((m) => m.t === 'error', 5000)
  const badCloseP = bad.waitForClose(5000)
  bad.sendText(JSON.stringify({ t: 'auth', v: 1, kind: 'host', id: REPLACE_ID, sig: 'AAAAAAAA' }))
  const badErr = await badErrP
  const badClose = await badCloseP
  assert(
    badErr.code === 'forbidden' && badClose.code === 4401,
    `bad auth: err=${JSON.stringify(badErr)} close=${badClose.code}, expected forbidden + 4401`,
  )
  ok(`bad HMAC signature rejected: ${JSON.stringify(badErr)} + close 4401`)

  const a = await connectEndpoint({ id: REPLACE_ID, kind: 'host', name: 'spike-replace-a', baseUrl: base })
  const closedP = a.waitForClose(5000)
  const b = await connectEndpoint({ id: REPLACE_ID, kind: 'host', name: 'spike-replace-b', baseUrl: base })
  const info = await closedP
  assert(info.code === 4409, `old socket closed with ${info.code}, expected 4409`)
  ok(`newest-wins: first connection closed with 4409 (${JSON.stringify(info)})`)
  const s = await getStats(base)
  assert(s.counters.replaced >= 1, 'replaced counter not incremented')
  b.close()
  await b.waitForClose(3000).catch(() => {})
}

async function phaseHibernate(ctx) {
  const { host, dev, base, cfg } = ctx
  // A pending auth-deadline alarm would wake the object mid-idle and muddy the
  // hibernation evidence; let it drain first (fires as a no-op sweep).
  await pollStats(base, (s) => s.alarmScheduledAt === null, 15000, 'pre-idle alarm drain')
  const before = await getStats(base)
  console.log(`      idling ${cfg.idleMs} ms (hibernation threshold: 10 s of no events)…`)
  await sleep(cfg.idleMs)
  assert(host.isOpen && dev.isOpen, `sockets not open after idle: host=${host.isOpen} dev=${dev.isOpen}`)
  const mid = await getStats(base)
  const wakesDelta = mid.counters.wakes - before.counters.wakes
  assert(wakesDelta >= 1, `no hibernation observed: wakes delta=${wakesDelta} (constructor did not re-run)`)
  ok(`hibernation observed: AccountHub constructor re-ran ${wakesDelta}× after ${cfg.idleMs} ms idle, sockets stayed open`)

  // Attachments must have survived hibernation: an authed frame still routes.
  const seq = ctx.probeSeq ?? 0
  const recvP = dev.waitBinary((buf) => {
    try {
      return parseFrame(buf).channel === CH_PROBE
    } catch {
      return false
    }
  }, 5000)
  host.sendBinary(encodeFrame({ channel: CH_PROBE, dstKind: dev.kindByte, dstId: dev.id, seq, payloadLen: 996 }))
  const reply = await recvP
  const f = parseFrame(reply)
  assert(f.srcKind === KIND_BYTE.host && f.srcId === host.id, 'post-hibernation frame not rewritten correctly')
  verifyPattern(reply, f.seq, f.payloadLen)
  ctx.probeSeq = seq + 1
  ok('attachment (auth state) survived hibernation: frame routed and verified after wake')

  const t0 = performance.now()
  const pong = host.waitText((m) => m.t === 'pong', 5000)
  host.sendText(PING)
  await pong
  ok(`auto-response still active after hibernation (pong in ${(performance.now() - t0).toFixed(1)}ms)`)
}

async function phaseAlarm(ctx) {
  const { host, dev, base, cfg } = ctx
  const s0 = await getStats(base)

  // (a) last host socket closes → alarm armed for +HOST_OFFLINE_ALERT_MS.
  host.close(1000)
  const sArmed = await pollStats(
    base,
    (s) => s.alarmScheduledAt !== null && s.tasks.some((t) => t.k === 'offline:host'),
    4000,
    'alarm armed',
  )
  ok(`host disconnect armed alarm (scheduledAt=${sArmed.alarmScheduledAt}, tasks=${JSON.stringify(sArmed.tasks)})`)

  // (b) reconnect before the alarm fires → task cleared, alarm deleted.
  const host2 = await connectEndpoint({ id: host.id, kind: host.kind, name: host.name, baseUrl: base })
  await pollStats(base, (s) => s.alarmScheduledAt === null, 4000, 'alarm canceled on reconnect')
  ok('host reconnect canceled the pending alarm (deleteAlarm)')
  await sleep(cfg.alertMs + 1500)
  const sQuiet = await getStats(base)
  assert(
    sQuiet.counters.alarms_fired === s0.counters.alarms_fired,
    `alarm fired while host was online: ${sQuiet.counters.alarms_fired} > ${s0.counters.alarms_fired}`,
  )
  ok(`no false alarm during ${cfg.alertMs + 1500} ms with host online (alarms_fired=${sQuiet.counters.alarms_fired})`)

  // (c) disconnect again and let the alarm fire. Filter by host id: a stale
  // buffered host_offline note from the replace-phase host may still be queued.
  const noteP = dev.waitText((m) => m.t === 'spike.host_offline' && m.hostId === host.id, cfg.alertMs + 10000)
  host2.close(1000)
  await pollStats(
    base,
    (s) => s.alarmScheduledAt !== null && s.tasks.some((t) => t.k === 'offline:host'),
    4000,
    'alarm re-armed',
  )
  const sFired = await pollStats(
    base,
    (s) => s.counters.alarms_fired > sQuiet.counters.alarms_fired,
    cfg.alertMs + 10000,
    'alarm fired',
  )
  ok(`alarm fired after ${cfg.alertMs} ms host offline (alarms_fired=${sFired.counters.alarms_fired})`)
  const noteMsg = await noteP
  ok(`device notified in-band for ${host.id}: ${JSON.stringify(noteMsg)}`)
  assert(
    sFired.offlineAlertRows === s0.offlineAlertRows + 1,
    `expected exactly one new offline_alerts row: before=${s0.offlineAlertRows} after=${sFired.offlineAlertRows}`,
  )
  ok(`offline_alerts row written (rows=${sFired.offlineAlertRows} = ${s0.offlineAlertRows} prior + 1 new)`)

  // Bonus: routing to the offline host must fail closed with peer_offline.
  const errP = dev.waitText((m) => m.t === 'error' && m.code === 'peer_offline', 5000)
  dev.sendBinary(
    encodeFrame({ channel: CH_PROBE, dstKind: KIND_BYTE.host, dstId: host.id, seq: 0, payloadLen: 996 }),
  )
  const err = await errP
  ok(`frame to offline host answered ${JSON.stringify(err)} (no buffering)`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cfg = parseArgs(process.argv.slice(2))
  const base = cfg.url.replace(/\/$/, '')
  const phases = cfg.phase === 'all' ? ALL_PHASES : cfg.phase.split(',').map((s) => s.trim())
  for (const p of phases) {
    if (!ALL_PHASES.includes(p)) throw new Error(`unknown phase "${p}" (known: ${ALL_PHASES.join(', ')})`)
  }
  console.log(`P0-S3 two-clients: url=${base} frames=${cfg.frames} rtt=${cfg.rtt} phases=${phases.join(',')}`)

  const health = await fetch(new URL('/v1/health', base)).then((r) => r.json())
  assert(health.ok === true && health.v === 1, `health check failed: ${JSON.stringify(health)}`)
  console.log('health ok')

  await enroll(base, '/v1/enroll/host', { id: HOST_ID, name: 'spike-host', platform: 'win32' })
  await enroll(base, '/v1/enroll/device', { id: DEV_ID, hostId: HOST_ID, name: 'spike-phone', platform: 'android' })
  console.log(`enrolled ${HOST_ID} + ${DEV_ID} (linked)`)

  const host = await connectEndpoint({ id: HOST_ID, kind: 'host', name: 'spike-host', baseUrl: base })
  const dev = await connectEndpoint({ id: DEV_ID, kind: 'device', name: 'spike-phone', baseUrl: base })
  console.log(`connected+authed: ${HOST_ID}, ${DEV_ID}`)

  const ctx = { host, dev, base, cfg, probeSeq: 0 }
  const run = {
    rtt: () => phaseRtt(ctx),
    throughput: () => phaseThroughput(ctx),
    oversize: () => phaseOversize(ctx),
    keepalive: () => phaseKeepalive(ctx),
    replace: () => phaseReplace(ctx),
    hibernate: () => phaseHibernate(ctx),
    alarm: () => phaseAlarm(ctx),
  }
  for (const p of phases) {
    console.log(`\n=== phase: ${p} ===`)
    const t0 = performance.now()
    try {
      await run[p]()
      console.log(`phase ${p} done in ${((performance.now() - t0) / 1000).toFixed(1)}s`)
    } catch (e) {
      failures.push(`${p}: ${e instanceof Error ? e.message : String(e)}`)
      console.error(`FAIL  [${p}] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
    }
  }

  const final = await getStats(base)
  console.log('\n=== final DO stats ===')
  console.log(JSON.stringify(final, null, 2))
  console.log(
    `billed model (local counters): http=${final.billed.httpRequests} ` +
      `wsIn=${final.billed.wsMessagesIn} → billed=${final.billed.wsMessagesBilled} ` +
      `alarms=${final.billed.alarms} total=${final.billed.total}`,
  )

  host.close()
  dev.close()
  await sleep(300)

  console.log('\n=== summary ===')
  console.log(`PASS: ${passes.length}  FAIL: ${failures.length}  NOTE: ${notes.length}`)
  for (const f of failures) console.log(`FAIL  ${f}`)
  process.exit(failures.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`FATAL ${e instanceof Error ? e.stack ?? e.message : String(e)}`)
  process.exit(1)
})
