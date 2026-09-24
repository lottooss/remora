/**
 * P0-S3 spike — RLY/1 relay mechanics on workerd.
 *
 * Throwaway prototype: not part of the pnpm workspace and never imported by
 * production code. Validates the mechanics RLY/1 depends on: one `AccountHub`
 * instance, hibernating WebSockets (tags + attachments), `setWebSocketAutoResponse`
 * keepalives that never wake the object, binary data-frame routing with the
 * 28-byte RLY/1 header (≤ 64 KiB, peer bytes rewritten), newest-wins replacement
 * (4409), the host-offline alarm, and request accounting for the free plan.
 *
 * Spike-only deviations from RLY/1 (see docs/spikes/P0-S3.md):
 * - Auth is HMAC-SHA256 over the challenge nonce with a demo key (stand-in for
 *   Crypto/1 §4 Ed25519 challenge/response).
 * - Endpoint ids are client-supplied ASCII ≤ 16 chars and occupy the 16-byte
 *   peer field verbatim (production: base32 of the 16-byte id hash).
 * - Enrollment routes are unauthenticated (production: bearer secret / ticket).
 * - Rate limits (RLY/1 §10) are not enforced so throughput is not distorted.
 */
import { DurableObject } from 'cloudflare:workers'

const HEADER_BYTES = 28
const KIND_HOST = 0x01
const KIND_DEVICE = 0x02
const CLOSE_NORMAL = 1000
const CLOSE_PROTOCOL = 4400
const CLOSE_AUTH_FAILED = 4401
const CLOSE_AUTH_TIMEOUT = 4408
const CLOSE_REPLACED = 4409
/** Exact byte strings matched by setWebSocketAutoResponse (RLY/1 §3 keepalive). */
const PING_REQ = '{"t":"ping"}'
const PING_RES = '{"t":"pong"}'
/** h_…/d_… ASCII ids that fit the 16-byte peer field (spike simplification). */
const ID_RE = /^[hd]_[A-Za-z0-9]{1,14}$/
const OFFLINE_TASK_KEY = 'offline:host'

type EndpointKind = 'host' | 'device'

interface Attachment {
  endpointId: string
  kind: EndpointKind
  nonce: string
  connectedAt: number
  authed: boolean
  authedAt: number | null
}

const COUNTER_KEYS = [
  'wakes',
  'fetch_in',
  'upgrades',
  'enroll_host',
  'enroll_device',
  'auth_ok',
  'auth_fail',
  'auth_timeouts',
  'ws_msg_in',
  'ws_msg_out',
  'control_in',
  'frames_in',
  'frames_routed',
  'frames_too_large',
  'frames_bad',
  'not_linked',
  'peer_offline',
  'errors_sent',
  'replaced',
  'closes',
  'pending_closed',
  'link_cache_rebuilds',
  'alarms_set',
  'alarms_fired',
  'offline_alerts',
] as const
type CounterKey = (typeof COUNTER_KEYS)[number]
type Counters = Record<CounterKey, number>

function emptyCounters(): Counters {
  const out = {} as Counters
  for (const k of COUNTER_KEYS) out[k] = 0
  return out
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function b64u(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Spike auth: HMAC-SHA256(key, nonce|id|kind) as base64url. */
async function hmacSign(keyStr: string, message: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(keyStr), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return b64u(new Uint8Array(sig))
}

/** Length-independent-time cost is spike-grade; production compares Ed25519 bytes. */
function ctEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length)
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

function encodeIdBytes(id: string): Uint8Array {
  const out = new Uint8Array(16)
  out.set(new TextEncoder().encode(id))
  return out
}

function decodePeerId(field: Uint8Array): string | null {
  let end = field.indexOf(0)
  if (end < 0) end = field.length
  if (end === 0) return null
  const id = new TextDecoder().decode(field.subarray(0, end))
  return ID_RE.test(id) ? id : null
}

function parseAttachment(ws: WebSocket): Attachment | null {
  const raw = ws.deserializeAttachment() as unknown
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.endpointId !== 'string' ||
    (o.kind !== 'host' && o.kind !== 'device') ||
    typeof o.nonce !== 'string' ||
    typeof o.connectedAt !== 'number' ||
    typeof o.authed !== 'boolean'
  ) {
    return null
  }
  return {
    endpointId: o.endpointId,
    kind: o.kind,
    nonce: o.nonce,
    connectedAt: o.connectedAt,
    authed: o.authed,
    authedAt: typeof o.authedAt === 'number' ? o.authedAt : null,
  }
}

async function readJsonBody(request: Request): Promise<unknown | null> {
  const text = await request.text()
  if (text.length > 4096) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export class AccountHub extends DurableObject<Env> {
  private counters: Counters = emptyCounters()
  private dirty = 0
  private lastFlush = Date.now()
  /** Link cache rebuilt from SQLite on wake; hibernation wipes it (rebuild on next wake). */
  private links = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(() => this.init())
  }

  private async init(): Promise<void> {
    const sql = this.ctx.storage.sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS endpoints (' +
        'id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN (\'host\',\'device\')), ' +
        'name TEXT NOT NULL, platform TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER)',
    )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS links (' +
        'host_id TEXT NOT NULL, device_id TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
        'PRIMARY KEY (host_id, device_id))',
    )
    sql.exec('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS tasks (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS offline_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, host_id TEXT NOT NULL, at INTEGER NOT NULL)')
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_REQ, PING_RES))
    this.loadCounters()
    this.loadLinks()
    this.counters.wakes += 1
    this.flushCounters()
  }

  private loadCounters(): void {
    for (const row of this.ctx.storage.sql.exec<{ k: string; v: number }>('SELECT k, v FROM counters')) {
      if ((COUNTER_KEYS as readonly string[]).includes(row.k)) this.counters[row.k as CounterKey] = row.v
    }
  }

  private loadLinks(): void {
    const next = new Set<string>()
    for (const row of this.ctx.storage.sql.exec<{ host_id: string; device_id: string }>('SELECT host_id, device_id FROM links')) {
      next.add(`${row.host_id}|${row.device_id}`)
    }
    this.links = next
    this.counters.link_cache_rebuilds += 1
  }

  private flushCounters(): void {
    const sql = this.ctx.storage.sql
    this.ctx.storage.transactionSync(() => {
      for (const k of COUNTER_KEYS) {
        sql.exec('INSERT INTO counters (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, this.counters[k])
      }
    })
    this.dirty = 0
    this.lastFlush = Date.now()
  }

  private bump(k: CounterKey, n = 1): void {
    this.counters[k] += n
    this.dirty += n
    if (this.dirty >= 100 || Date.now() - this.lastFlush >= 2000) this.flushCounters()
  }

  private intVar(name: string, fallback: number): number {
    const n = Number(this.env[name as keyof Env])
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  private maxFrameBytes(): number {
    return this.intVar('MAX_FRAME_BYTES', 65536)
  }

  private authTimeoutMs(): number {
    return this.intVar('AUTH_TIMEOUT_MS', 10000)
  }

  private hostOfflineAlertMs(): number {
    return this.intVar('HOST_OFFLINE_ALERT_MS', 120000)
  }

  private spikeAuthKey(): string {
    const k = this.env.SPIKE_AUTH_KEY
    if (typeof k !== 'string' || k.length === 0) throw new Error('SPIKE_AUTH_KEY missing')
    return k
  }

  private isAuthed(ws: WebSocket): boolean {
    return parseAttachment(ws)?.authed === true
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload))
      this.bump('ws_msg_out')
    } catch {
      // Socket already gone; accounting counters still flush on the next event.
    }
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    this.bump('errors_sent')
    this.sendJson(ws, { t: 'error', code, message })
  }

  /** Arm `at` only if no alarm is scheduled, or the existing one is later. */
  private async armMinAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }

  private nextAuthDeadline(): number | null {
    let next: number | null = null
    for (const ws of this.ctx.getWebSockets()) {
      const att = parseAttachment(ws)
      if (!att || att.authed) continue
      const deadline = att.connectedAt + this.authTimeoutMs()
      if (next === null || deadline < next) next = deadline
    }
    return next
  }

  override async fetch(request: Request): Promise<Response> {
    this.bump('fetch_in')
    const url = new URL(request.url)
    if (url.pathname === '/v1/connect') return await this.handleConnect(request, url)
    if (url.pathname === '/v1/enroll/host' && request.method === 'POST') return this.handleEnrollHost(request)
    if (url.pathname === '/v1/enroll/device' && request.method === 'POST') return this.handleEnrollDevice(request)
    if (url.pathname === '/v1/stats' && request.method === 'GET') return this.handleStats()
    return json({ error: 'not_found' }, 404)
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'bad_request', message: 'expected websocket upgrade' }, 400)
    }
    const id = url.searchParams.get('id') ?? ''
    const kindParam = url.searchParams.get('kind') ?? ''
    if (!ID_RE.test(id) || (kindParam !== 'host' && kindParam !== 'device')) {
      return json({ error: 'bad_request', message: 'invalid id or kind' }, 400)
    }
    const kind: EndpointKind = kindParam
    if ((kind === 'host' && !id.startsWith('h_')) || (kind === 'device' && !id.startsWith('d_'))) {
      return json({ error: 'bad_request', message: 'id prefix must match kind' }, 400)
    }
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    if (client === undefined || server === undefined) return json({ error: 'internal' }, 500)

    const nonce = b64u(crypto.getRandomValues(new Uint8Array(32)))
    const att: Attachment = { endpointId: id, kind, nonce, connectedAt: Date.now(), authed: false, authedAt: null }

    this.ctx.acceptWebSocket(server, [id])
    server.serializeAttachment(att)
    this.bump('upgrades')
    server.send(JSON.stringify({ t: 'challenge', v: 1, nonce, time: att.connectedAt }))
    this.bump('ws_msg_out')
    // Auth-deadline sweep: one alarm slot multiplexed with host-offline (see alarm()).
    await this.armMinAlarm(att.connectedAt + this.authTimeoutMs())
    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleEnrollHost(request: Request): Promise<Response> {
    const body = (await readJsonBody(request)) as { id?: unknown; name?: unknown; platform?: unknown } | null
    if (body === null || typeof body !== 'object') return json({ error: 'bad_request' }, 400)
    const id = typeof body.id === 'string' ? body.id : ''
    if (!ID_RE.test(id) || !id.startsWith('h_')) return json({ error: 'bad_request', message: 'invalid host id' }, 400)
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 64) : id
    const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'INSERT INTO endpoints (id, kind, name, platform, created_at, last_seen_at) VALUES (?1, \'host\', ?2, ?3, ?4, ?4) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at',
      id,
      name,
      platform,
      now,
    )
    this.bump('enroll_host')
    return json({ v: 1, id })
  }

  private async handleEnrollDevice(request: Request): Promise<Response> {
    const body = (await readJsonBody(request)) as { id?: unknown; hostId?: unknown; name?: unknown; platform?: unknown } | null
    if (body === null || typeof body !== 'object') return json({ error: 'bad_request' }, 400)
    const id = typeof body.id === 'string' ? body.id : ''
    const hostId = typeof body.hostId === 'string' ? body.hostId : ''
    if (!ID_RE.test(id) || !id.startsWith('d_') || !ID_RE.test(hostId) || !hostId.startsWith('h_')) {
      return json({ error: 'bad_request', message: 'invalid device or host id' }, 400)
    }
    const host = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM endpoints WHERE id = ?1', hostId).toArray()
    if (host.length === 0) return json({ error: 'bad_request', message: 'unknown host; enroll the host first' }, 400)
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 64) : id
    const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null
    const now = Date.now()
    this.ctx.storage.sql.exec(
      'INSERT INTO endpoints (id, kind, name, platform, created_at, last_seen_at) VALUES (?1, \'device\', ?2, ?3, ?4, ?4) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at',
      id,
      name,
      platform,
      now,
    )
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO links (host_id, device_id, created_at) VALUES (?1, ?2, ?3)', hostId, id, now)
    this.links.add(`${hostId}|${id}`)
    this.bump('enroll_device')
    return json({ v: 1, id, hostId })
  }

  private async handleStats(): Promise<Response> {
    this.flushCounters()
    const auto = this.ctx.getWebSocketAutoResponse()
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const att = parseAttachment(ws)
      const lastAuto = this.ctx.getWebSocketAutoResponseTimestamp(ws)
      return {
        id: att === null ? null : att.endpointId.slice(0, 6),
        kind: att?.kind ?? null,
        authed: att?.authed ?? false,
        tags: this.ctx.getTags(ws),
        lastAutoResponseAt: lastAuto === null ? null : lastAuto.toISOString(),
      }
    })
    const tasks = [...this.ctx.storage.sql.exec<{ k: string; v: string }>('SELECT k, v FROM tasks')].map((r) => ({ k: r.k, v: r.v }))
    const alerts = this.ctx.storage.sql.exec<{ c: number }>('SELECT COUNT(*) AS c FROM offline_alerts').toArray()[0]?.c ?? 0
    const alarmAt = await this.ctx.storage.getAlarm()
    const c = this.counters
    return json({
      counters: c,
      billed: {
        httpRequests: c.fetch_in,
        wsMessagesIn: c.ws_msg_in,
        wsMessagesBilled: Math.ceil(c.ws_msg_in / 20),
        alarms: c.alarms_fired,
        total: c.fetch_in + Math.ceil(c.ws_msg_in / 20) + c.alarms_fired,
      },
      alarmScheduledAt: alarmAt,
      autoResponse: auto === null ? null : { request: auto.request, response: auto.response },
      offlineAlertRows: alerts,
      tasks,
      sockets,
      links: this.links.size,
    })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.bump('ws_msg_in')
    const att = parseAttachment(ws)
    if (att === null) {
      ws.close(CLOSE_PROTOCOL, 'missing attachment')
      return
    }
    if (typeof message === 'string') await this.onControl(ws, att, message)
    else await this.onData(ws, att, new Uint8Array(message))
  }

  private async onControl(ws: WebSocket, att: Attachment, message: string): Promise<void> {
    this.bump('control_in')
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(message)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
      msg = parsed as Record<string, unknown>
    } catch {
      this.sendError(ws, 'bad_request', 'malformed control frame')
      ws.close(CLOSE_PROTOCOL, 'malformed control frame')
      return
    }
    switch (msg.t) {
      case 'auth':
        await this.onAuth(ws, att, msg)
        return
      case 'bye':
        ws.close(CLOSE_NORMAL, 'bye')
        return
      default:
        this.sendError(ws, 'bad_request', 'unknown control frame type')
        return
    }
  }

  private async onAuth(ws: WebSocket, att: Attachment, msg: Record<string, unknown>): Promise<void> {
    if (att.authed) {
      this.sendError(ws, 'bad_request', 'already authenticated')
      return
    }
    const id = typeof msg.id === 'string' ? msg.id : ''
    const kind = msg.kind
    const sig = typeof msg.sig === 'string' ? msg.sig : ''
    if (msg.v !== 1 || id !== att.endpointId || (kind !== 'host' && kind !== 'device') || kind !== att.kind || sig.length === 0) {
      await this.failAuth(ws)
      return
    }
    const expected = await hmacSign(this.spikeAuthKey(), `${att.nonce}|${att.endpointId}|${kind}`)
    if (!ctEqual(expected, sig)) {
      await this.failAuth(ws)
      return
    }

    // Success: persist auth state before replacement so the new socket counts
    // as online when the old socket's webSocketClose runs.
    att.authed = true
    att.authedAt = Date.now()
    ws.serializeAttachment(att)

    // Newest-wins (RLY/1 §3): every other socket of this endpoint → 4409.
    for (const other of this.ctx.getWebSockets(att.endpointId)) {
      if (other === ws) continue
      try {
        other.close(CLOSE_REPLACED, 'replaced by newer connection')
      } catch {
        // Already closing.
      }
      this.bump('replaced')
    }

    const now = Date.now()
    this.ctx.storage.sql.exec(
      'INSERT INTO endpoints (id, kind, name, created_at, last_seen_at) VALUES (?1, ?2, ?1, ?3, ?3) ' +
        'ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at',
      att.endpointId,
      att.kind,
      now,
    )

    if (att.kind === 'host') await this.cancelOfflineTask(att.endpointId)
    this.bump('auth_ok')
    this.sendJson(ws, {
      t: 'ready',
      v: 1,
      id: att.endpointId,
      peers: [],
      limits: { maxFrameBytes: this.maxFrameBytes() },
    })
  }

  private async failAuth(ws: WebSocket): Promise<void> {
    this.bump('auth_fail')
    this.sendError(ws, 'forbidden', 'authentication failed')
    ws.close(CLOSE_AUTH_FAILED, 'authentication failed')
  }

  /** Host reconnect: clear the offline task and re-arm only auth deadlines (RLY/1 §8). */
  private async cancelOfflineTask(hostId: string): Promise<void> {
    const sql = this.ctx.storage.sql
    const rows = sql.exec<{ v: string }>('SELECT v FROM tasks WHERE k = ?1', OFFLINE_TASK_KEY).toArray()
    const row = rows[0]
    let hadTask = false
    if (row !== undefined) {
      try {
        const task = JSON.parse(row.v) as { hostId?: unknown }
        if (task.hostId === hostId) {
          sql.exec('DELETE FROM tasks WHERE k = ?1', OFFLINE_TASK_KEY)
          hadTask = true
        }
      } catch {
        // Corrupt task row: fall through and re-arm from live state.
      }
    }
    if (hadTask) await this.ctx.storage.deleteAlarm()
    const nextAuth = this.nextAuthDeadline()
    if (nextAuth !== null) await this.armMinAlarm(nextAuth)
  }

  private async onData(ws: WebSocket, att: Attachment, bytes: Uint8Array): Promise<void> {
    this.bump('frames_in')
    const max = this.maxFrameBytes()
    if (bytes.length > max) {
      this.bump('frames_too_large')
      this.sendError(ws, 'too_large', `frame exceeds ${max} bytes`)
      return
    }
    if (bytes.length < HEADER_BYTES) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'frame shorter than header')
      return
    }
    if (!att.authed) {
      ws.close(CLOSE_AUTH_FAILED, 'not authenticated')
      return
    }
    const version = bytes[0]
    const type = bytes[1]
    const reserved0 = bytes[2]
    const reserved1 = bytes[3]
    const dstKindByte = bytes[8]
    if (version !== 0x01 || type !== 0x01 || reserved0 !== 0x00 || reserved1 !== 0x00 || dstKindByte === undefined) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'unsupported or malformed frame header')
      return
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const channel = view.getUint32(4)
    if (channel === 0) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'channel must be non-zero')
      return
    }
    if (dstKindByte !== KIND_HOST && dstKindByte !== KIND_DEVICE) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'invalid peer kind')
      return
    }
    const dstKind: EndpointKind = dstKindByte === KIND_HOST ? 'host' : 'device'
    const dstId = decodePeerId(bytes.subarray(9, 25))
    if (dstId === null || dstId[0] !== (dstKind === 'host' ? 'h' : 'd')) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'invalid destination id')
      return
    }
    if (dstKind === att.kind) {
      this.bump('not_linked')
      this.sendError(ws, 'not_linked', 'destination not linked')
      return
    }
    const hostId = att.kind === 'host' ? att.endpointId : dstId
    const deviceId = att.kind === 'device' ? att.endpointId : dstId
    if (!this.links.has(`${hostId}|${deviceId}`)) {
      this.bump('not_linked')
      this.sendError(ws, 'not_linked', 'destination not linked')
      return
    }
    const dests = this.ctx.getWebSockets(dstId).filter((o) => this.isAuthed(o))
    if (dests.length === 0) {
      this.bump('peer_offline')
      this.sendError(ws, 'peer_offline', 'destination offline')
      return
    }
    // Rewrite only the 17 peer bytes: destination → source (RLY/1 §6).
    bytes[8] = att.kind === 'host' ? KIND_HOST : KIND_DEVICE
    bytes.set(encodeIdBytes(att.endpointId), 9)
    let forwarded = 0
    for (const dest of dests) {
      try {
        dest.send(bytes)
        forwarded += 1
        this.bump('ws_msg_out')
      } catch {
        // Raced a close; peer_offline below if nothing landed.
      }
    }
    if (forwarded === 0) {
      this.bump('peer_offline')
      this.sendError(ws, 'peer_offline', 'destination offline')
      return
    }
    this.bump('frames_routed')
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.bump('closes')
    const att = parseAttachment(ws)
    if (att !== null && !att.authed) this.bump('pending_closed')
    if (att !== null && att.authed && att.kind === 'host') {
      const remaining = this.ctx.getWebSockets(att.endpointId).filter((o) => o !== ws && this.isAuthed(o))
      if (remaining.length === 0) {
        const due = Date.now() + this.hostOfflineAlertMs()
        this.ctx.storage.sql.exec(
          'INSERT INTO tasks (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
          OFFLINE_TASK_KEY,
          JSON.stringify({ hostId: att.endpointId, due }),
        )
        this.bump('alarms_set')
        await this.armMinAlarm(due)
      }
    }
    void code
    void reason
    void wasClean
    this.flushCounters()
  }

  /**
   * One alarm slot multiplexes: (1) host-offline alert (RLY/1 §8, shortened by
   * HOST_OFFLINE_ALERT_MS), (2) auth-timeout sweep for sockets that connected
   * but never authenticated (no setTimeout — it would block hibernation).
   */
  override async alarm(): Promise<void> {
    this.bump('alarms_fired')
    const now = Date.now()
    const sql = this.ctx.storage.sql
    const rearm: number[] = []

    const taskRows = sql.exec<{ v: string }>('SELECT v FROM tasks WHERE k = ?1', OFFLINE_TASK_KEY).toArray()
    const taskRow = taskRows[0]
    if (taskRow !== undefined) {
      let task: { hostId?: unknown; due?: unknown } | null = null
      try {
        task = JSON.parse(taskRow.v) as { hostId?: unknown; due?: unknown }
      } catch {
        task = null
      }
      if (task !== null && typeof task.hostId === 'string' && typeof task.due === 'number') {
        if (now < task.due) {
          rearm.push(task.due)
        } else {
          const online = this.ctx.getWebSockets(task.hostId).some((o) => this.isAuthed(o))
          if (!online) {
            sql.exec('INSERT INTO offline_alerts (host_id, at) VALUES (?1, ?2)', task.hostId, now)
            this.bump('offline_alerts')
            for (const peer of this.ctx.getWebSockets()) {
              const peerAtt = parseAttachment(peer)
              if (peerAtt !== null && peerAtt.authed && peerAtt.kind === 'device') {
                this.sendJson(peer, { t: 'spike.host_offline', v: 1, hostId: task.hostId })
              }
            }
            console.log(`[spike] host_offline_alert host=${task.hostId.slice(0, 6)}`)
          }
          sql.exec('DELETE FROM tasks WHERE k = ?1', OFFLINE_TASK_KEY)
        }
      } else {
        sql.exec('DELETE FROM tasks WHERE k = ?1', OFFLINE_TASK_KEY)
      }
    }

    const timeout = this.authTimeoutMs()
    for (const ws of this.ctx.getWebSockets()) {
      const att = parseAttachment(ws)
      if (att === null || att.authed) continue
      const deadline = att.connectedAt + timeout
      if (now >= deadline) {
        try {
          ws.close(CLOSE_AUTH_TIMEOUT, 'authentication timeout')
        } catch {
          // Already gone.
        }
        this.bump('auth_timeouts')
      } else {
        rearm.push(deadline)
      }
    }

    const future = rearm.filter((t) => t > now)
    if (future.length > 0) await this.ctx.storage.setAlarm(Math.min(...future))
    this.flushCounters()
  }
}

const HUB_PATHS: ReadonlySet<string> = new Set([
  '/v1/connect',
  '/v1/enroll/host',
  '/v1/enroll/device',
  '/v1/stats',
])

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/v1/health' && request.method === 'GET') return json({ ok: true, v: 1 })
    if (HUB_PATHS.has(pathname)) {
      const hub = env.ACCOUNT_HUB.get(env.ACCOUNT_HUB.idFromName('account'))
      return hub.fetch(request)
    }
    return json({ error: 'not_found' }, 404)
  },
} satisfies ExportedHandler<Env>
