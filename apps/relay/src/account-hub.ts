/**
 * `AccountHub`: the single Durable Object per owner (RLY/1 §1).
 * Handles SQLite schema migrations, WebSocket hibernation, auto-response keepalives,
 * authentication with Ed25519 challenge verification, enrollment, routing with 17-byte
 * header rewrite, presence tracking, token-bucket limits, FCM push dispatch, the
 * host-offline DO alarm, and clean close codes.
 *
 * Implements RLY/1 §2–§11 (core: task P1-R1; push + host-offline alarm: P5-R1).
 */
import { DurableObject } from 'cloudflare:workers'
import {
  CloseCodes,
  DATA_FRAME_HEADER_BYTES,
  MAX_DATA_FRAME_BYTES,
  MAX_ENDPOINTS,
  RLY_SUBPROTOCOL,
  RLY_VERSION,
  type Peer,
} from '@remora/protocol'
import {
  decodeBase32,
  decodeBase64Url,
  deriveEndpointId,
  encodeBase32,
  encodeBase64Url,
  randomBytes,
  verifyRelayChallenge,
} from '@remora/crypto'
import { type FcmEnv, sendFcmDataMessage } from './fcm.ts'

const PING_REQ = '{"t":"ping"}'
const PING_RES = '{"t":"pong"}'
const OFFLINE_TASK_PREFIX = 'offline:host:'

export type EndpointKind = 'host' | 'device'

export interface Attachment {
  endpointId: string | null
  kind: EndpointKind | null
  nonce: string
  connectedAt: number
  authed: boolean
  authedAt: number | null
  tokens: number
  lastTokenRefill: number
}

export const COUNTER_KEYS = [
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
] as const

export type CounterKey = (typeof COUNTER_KEYS)[number]
export type Counters = Record<CounterKey, number>

function emptyCounters(): Counters {
  const out = {} as Counters
  for (const k of COUNTER_KEYS) out[k] = 0
  return out
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  return new Uint8Array(hash)
}

function parseAttachment(ws: WebSocket): Attachment | null {
  const raw = ws.deserializeAttachment() as unknown
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (
    typeof o.nonce !== 'string' ||
    typeof o.connectedAt !== 'number' ||
    typeof o.authed !== 'boolean'
  ) {
    return null
  }
  return {
    endpointId: typeof o.endpointId === 'string' ? o.endpointId : null,
    kind: o.kind === 'host' || o.kind === 'device' ? o.kind : null,
    nonce: o.nonce,
    connectedAt: o.connectedAt,
    authed: o.authed,
    authedAt: typeof o.authedAt === 'number' ? o.authedAt : null,
    tokens: typeof o.tokens === 'number' ? o.tokens : 100,
    lastTokenRefill: typeof o.lastTokenRefill === 'number' ? o.lastTokenRefill : o.connectedAt,
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
  /** Link cache: host_id|device_id */
  private links = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(() => this.init())
  }

  private async init(): Promise<void> {
    const sql = this.ctx.storage.sql
    sql.exec(
      'CREATE TABLE IF NOT EXISTS endpoints (' +
        'id TEXT PRIMARY KEY, ' +
        'kind TEXT NOT NULL CHECK (kind IN (\'host\',\'device\')), ' +
        'relay_pub BLOB NOT NULL, ' +
        'name TEXT NOT NULL, ' +
        'platform TEXT, ' +
        'created_at INTEGER NOT NULL, ' +
        'last_seen_at INTEGER, ' +
        'revoked_at INTEGER, ' +
        'fcm_token TEXT, ' +
        'host_offline INTEGER DEFAULT 0)',
    )
    try {
      sql.exec('ALTER TABLE endpoints ADD COLUMN host_offline INTEGER DEFAULT 0')
    } catch {
      // Column already exists
    }
    sql.exec(
      'CREATE TABLE IF NOT EXISTS links (' +
        'host_id TEXT NOT NULL, ' +
        'device_id TEXT NOT NULL, ' +
        'created_at INTEGER NOT NULL, ' +
        'PRIMARY KEY (host_id, device_id))',
    )
    sql.exec(
      'CREATE TABLE IF NOT EXISTS tickets (' +
        'ticket_hash BLOB PRIMARY KEY, ' +
        'host_id TEXT NOT NULL, ' +
        'expires_at INTEGER NOT NULL, ' +
        'used_at INTEGER)',
    )
    sql.exec('CREATE TABLE IF NOT EXISTS counters (k TEXT PRIMARY KEY, v INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS tasks (k TEXT PRIMARY KEY, v TEXT NOT NULL)')

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
    return this.intVar('MAX_FRAME_BYTES', MAX_DATA_FRAME_BYTES)
  }

  private maxEndpoints(): number {
    return this.intVar('MAX_ENDPOINTS', MAX_ENDPOINTS)
  }

  private authTimeoutMs(): number {
    return this.intVar('AUTH_TIMEOUT_MS', 10000)
  }

  private hostOfflineAlertMs(): number {
    return this.intVar('HOST_OFFLINE_ALERT_MS', 120000)
  }

  private rateFramesPerSec(): number {
    return this.intVar('RATE_FRAMES_PER_SEC', 50)
  }

  private rateBurst(): number {
    return this.intVar('RATE_BURST', 100)
  }

  private isAuthed(ws: WebSocket): boolean {
    return ws.readyState === 1 && parseAttachment(ws)?.authed === true
  }

  private sendJson(ws: WebSocket, payload: unknown): void {
    try {
      ws.send(JSON.stringify(payload))
      this.bump('ws_msg_out')
    } catch {
      // Socket closing
    }
  }

  private sendError(ws: WebSocket, code: string, message: string, rid?: string): void {
    this.bump('errors_sent')
    const frame: Record<string, unknown> = { t: 'error', code, message }
    if (rid) frame.rid = rid
    this.sendJson(ws, frame)
  }

  private async armMinAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || at < current) await this.ctx.storage.setAlarm(at)
  }

  private findSocketsFor(endpointId: string): WebSocket[] {
    const tagged = this.ctx.getWebSockets(endpointId).filter((ws) => ws.readyState === 1)
    if (tagged.length > 0) return tagged
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === 1 && parseAttachment(ws)?.endpointId === endpointId)
  }

  override async fetch(request: Request): Promise<Response> {
    this.bump('fetch_in')
    const url = new URL(request.url)
    if (url.pathname === '/v1/connect') return await this.handleConnect(request, url)
    if (url.pathname === '/v1/enroll/host' && request.method === 'POST') return await this.handleEnrollHost(request)
    if (url.pathname === '/v1/enroll/device' && request.method === 'POST') return await this.handleEnrollDevice(request)
    if (url.pathname === '/v1/stats' && request.method === 'GET') return this.handleStats()
    return json({ error: 'not_found' }, 404)
  }

  private async handleConnect(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'bad_request', message: 'expected websocket upgrade' }, 400)
    }

    const subproto = request.headers.get('Sec-WebSocket-Protocol') ?? ''
    const protocols = subproto.split(',').map((s) => s.trim())
    if (!protocols.includes(RLY_SUBPROTOCOL)) {
      return json({ error: 'bad_request', message: `missing required subprotocol ${RLY_SUBPROTOCOL}` }, 400)
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    if (!client || !server) return json({ error: 'internal' }, 500)

    const nonceBytes = randomBytes(32)
    const nonce = encodeBase64Url(nonceBytes)
    const now = Date.now()

    const paramId = url.searchParams.get('id')
    const tags = paramId ? [paramId] : ['pending']

    const att: Attachment = {
      endpointId: paramId,
      kind: url.searchParams.get('kind') === 'host' ? 'host' : url.searchParams.get('kind') === 'device' ? 'device' : null,
      nonce,
      connectedAt: now,
      authed: false,
      authedAt: null,
      tokens: this.rateBurst(),
      lastTokenRefill: now,
    }

    this.ctx.acceptWebSocket(server, tags)
    server.serializeAttachment(att)
    this.bump('upgrades')

    server.send(JSON.stringify({ t: 'challenge', v: RLY_VERSION, nonce, time: now }))
    this.bump('ws_msg_out')

    await this.armMinAlarm(now + this.authTimeoutMs())

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL,
      },
    })
  }

  private async handleEnrollHost(request: Request): Promise<Response> {
    const authHeader = request.headers.get('Authorization') ?? ''
    const expectedSecret = (this.env as any).REMORA_ENROLL_SECRET ?? 'test-enroll-secret'
    const expectedHeader = `Bearer ${expectedSecret}`

    if (!constantTimeEqual(authHeader, expectedHeader)) {
      return json({ error: 'unauthorized', message: 'Invalid enrollment secret' }, 401)
    }

    const body = (await readJsonBody(request)) as {
      v?: unknown
      relayPub?: unknown
      name?: unknown
      platform?: unknown
    } | null

    if (!body || body.v !== RLY_VERSION || typeof body.relayPub !== 'string') {
      return json({ error: 'bad_request', message: 'Invalid enrollment payload' }, 400)
    }

    let pubBytes: Uint8Array
    try {
      pubBytes = decodeBase64Url(body.relayPub)
      if (pubBytes.length !== 32) throw new Error('invalid key length')
    } catch {
      return json({ error: 'bad_request', message: 'Invalid relayPub (expected 32-byte b64u)' }, 400)
    }

    const hostId = deriveEndpointId('h_', pubBytes)
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 64) : hostId
    const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null
    const now = Date.now()

    const existingCount = this.ctx.storage.sql.exec<{ c: number }>(
      'SELECT COUNT(*) as c FROM endpoints WHERE revoked_at IS NULL AND id != ?1',
      hostId,
    ).toArray()[0]?.c ?? 0

    if (existingCount >= this.maxEndpoints()) {
      return json({ error: 'rate_limited', message: 'Maximum endpoint capacity reached' }, 429)
    }

    this.ctx.storage.sql.exec(
      'INSERT INTO endpoints (id, kind, relay_pub, name, platform, created_at, last_seen_at) VALUES (?1, \'host\', ?2, ?3, ?4, ?5, ?5) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at',
      hostId,
      pubBytes,
      name,
      platform,
      now,
    )

    this.bump('enroll_host')
    return json({ v: RLY_VERSION, id: hostId })
  }

  private async handleEnrollDevice(request: Request): Promise<Response> {
    const body = (await readJsonBody(request)) as {
      v?: unknown
      ticket?: unknown
      relayPub?: unknown
      name?: unknown
      platform?: unknown
    } | null

    if (!body || body.v !== RLY_VERSION || typeof body.ticket !== 'string' || typeof body.relayPub !== 'string') {
      return json({ error: 'bad_request', message: 'Invalid enrollment payload' }, 400)
    }

    let ticketBytes: Uint8Array
    let pubBytes: Uint8Array
    try {
      ticketBytes = decodeBase64Url(body.ticket)
      pubBytes = decodeBase64Url(body.relayPub)
      if (pubBytes.length !== 32) throw new Error('invalid key length')
    } catch {
      return json({ error: 'bad_request', message: 'Invalid base64url encoding' }, 400)
    }

    const ticketHash = await sha256(ticketBytes)
    const now = Date.now()

    const ticketRows = this.ctx.storage.sql.exec<{
      host_id: string
      expires_at: number
      used_at: number | null
    }>('SELECT host_id, expires_at, used_at FROM tickets WHERE ticket_hash = ?1', ticketHash).toArray()

    const ticketRow = ticketRows[0]
    if (!ticketRow || ticketRow.used_at !== null || ticketRow.expires_at < now) {
      return json({ error: 'ticket_invalid', message: 'Ticket unknown, expired, or already used' }, 410)
    }

    // Atomically mark ticket used
    this.ctx.storage.sql.exec('UPDATE tickets SET used_at = ?1 WHERE ticket_hash = ?2', now, ticketHash)

    const deviceId = deriveEndpointId('d_', pubBytes)
    const name = typeof body.name === 'string' && body.name.length > 0 ? body.name.slice(0, 64) : deviceId
    const platform = typeof body.platform === 'string' ? body.platform.slice(0, 32) : null

    const existingCount = this.ctx.storage.sql.exec<{ c: number }>(
      'SELECT COUNT(*) as c FROM endpoints WHERE revoked_at IS NULL AND id != ?1',
      deviceId,
    ).toArray()[0]?.c ?? 0

    if (existingCount >= this.maxEndpoints()) {
      return json({ error: 'rate_limited', message: 'Maximum endpoint capacity reached' }, 429)
    }

    this.ctx.storage.sql.exec(
      'INSERT INTO endpoints (id, kind, relay_pub, name, platform, created_at, last_seen_at) VALUES (?1, \'device\', ?2, ?3, ?4, ?5, ?5) ' +
        'ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, last_seen_at = excluded.last_seen_at',
      deviceId,
      pubBytes,
      name,
      platform,
      now,
    )

    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO links (host_id, device_id, created_at) VALUES (?1, ?2, ?3)',
      ticketRow.host_id,
      deviceId,
      now,
    )
    this.links.add(`${ticketRow.host_id}|${deviceId}`)

    this.bump('enroll_device')
    return json({ v: RLY_VERSION, id: deviceId, hostId: ticketRow.host_id })
  }

  private handleStats(): Response {
    this.flushCounters()
    const sockets = this.ctx.getWebSockets().map((ws) => {
      const att = parseAttachment(ws)
      return {
        id: att?.endpointId ? att.endpointId.slice(0, 6) : null,
        kind: att?.kind ?? null,
        authed: att?.authed ?? false,
      }
    })
    return json({
      counters: this.counters,
      sockets,
      links: this.links.size,
    })
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.bump('ws_msg_in')
    const att = parseAttachment(ws)
    if (att === null) {
      ws.close(CloseCodes.MALFORMED, 'missing attachment')
      return
    }

    // Token bucket rate limiting: 50 msg/s, burst 100
    const now = Date.now()
    const elapsedSec = Math.max(0, (now - att.lastTokenRefill) / 1000)
    att.tokens = Math.min(this.rateBurst(), att.tokens + elapsedSec * this.rateFramesPerSec())
    att.lastTokenRefill = now

    if (att.tokens < 1) {
      this.sendError(ws, 'rate_limited', 'Rate limit exceeded')
      return
    }
    att.tokens -= 1
    ws.serializeAttachment(att)

    if (typeof message === 'string') {
      await this.onControl(ws, att, message)
    } else {
      await this.onData(ws, att, new Uint8Array(message))
    }
  }

  private async onControl(ws: WebSocket, att: Attachment, message: string): Promise<void> {
    this.bump('control_in')
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(message)
      if (typeof frame !== 'object' || frame === null) throw new Error('not an object')
    } catch {
      this.sendError(ws, 'bad_request', 'Malformed control frame')
      ws.close(CloseCodes.MALFORMED, 'malformed control frame')
      return
    }

    const t = typeof frame.t === 'string' ? frame.t : ''
    const rid = typeof frame.rid === 'string' ? frame.rid : undefined

    if (!att.authed) {
      if (t === 'auth') {
        await this.onAuth(ws, att, frame)
      } else {
        this.sendError(ws, 'forbidden', 'Must authenticate first')
        ws.close(CloseCodes.AUTH_FAILED, 'unauthenticated')
      }
      return
    }

    switch (t) {
      case 'enroll.ticket':
        await this.onEnrollTicket(ws, att, frame, rid)
        break
      case 'endpoint.list':
        await this.onEndpointList(ws, att, frame, rid)
        break
      case 'endpoint.revoke':
        await this.onEndpointRevoke(ws, att, frame, rid)
        break
      case 'push.token':
        await this.onPushToken(ws, att, frame, rid)
        break
      case 'push':
        await this.onPush(ws, att, frame, rid)
        break
      case 'bye':
        ws.close(CloseCodes.NORMAL, 'bye')
        break
      default:
        this.sendError(ws, 'bad_request', `Unknown control frame type: ${t}`, rid)
        break
    }
  }

  private async onAuth(ws: WebSocket, att: Attachment, frame: Record<string, unknown>): Promise<void> {
    const now = Date.now()
    if (now - att.connectedAt > this.authTimeoutMs()) {
      this.bump('auth_timeouts')
      ws.close(CloseCodes.AUTH_TIMEOUT, 'authentication timeout')
      return
    }

    const id = typeof frame.id === 'string' ? frame.id : ''
    const kind = frame.kind === 'host' ? 'host' : frame.kind === 'device' ? 'device' : null
    const sigStr = typeof frame.sig === 'string' ? frame.sig : ''

    if (!kind || !id || !sigStr) {
      await this.failAuth(ws)
      return
    }

    const endpointRows = this.ctx.storage.sql.exec<{
      relay_pub: ArrayBuffer
      revoked_at: number | null
    }>('SELECT relay_pub, revoked_at FROM endpoints WHERE id = ?1 AND kind = ?2', id, kind).toArray()

    const endpoint = endpointRows[0]
    if (!endpoint || endpoint.revoked_at !== null) {
      this.bump('auth_fail')
      this.sendError(ws, 'forbidden', 'Endpoint unknown or revoked')
      ws.close(CloseCodes.FORBIDDEN, 'endpoint revoked or unknown')
      return
    }

    const relayPub = new Uint8Array(endpoint.relay_pub)
    let valid = false
    try {
      const sigBytes = decodeBase64Url(sigStr)
      valid = verifyRelayChallenge(relayPub, att.nonce, sigBytes)
    } catch {
      valid = false
    }

    if (!valid) {
      await this.failAuth(ws)
      return
    }

    // Newest-wins replacement (RLY/1 §3, close 4409)
    for (const existing of this.findSocketsFor(id)) {
      if (existing !== ws) {
        try {
          existing.close(CloseCodes.CLIENT_REPLACED, 'replaced by newer connection')
        } catch {
          // ignore
        }
        this.bump('replaced')
      }
    }

    att.authed = true
    att.authedAt = now
    att.endpointId = id
    att.kind = kind
    ws.serializeAttachment(att)

    // Update last seen
    this.ctx.storage.sql.exec('UPDATE endpoints SET last_seen_at = ?1 WHERE id = ?2', now, id)

    if (kind === 'host') {
      await this.cancelOfflineTask(id)
    }

    this.bump('auth_ok')

    // Query linked peers for initial state
    const peers = this.getLinkedPeers(id, kind)

    this.sendJson(ws, {
      t: 'ready',
      v: RLY_VERSION,
      id,
      peers,
      limits: {
        maxFrameBytes: this.maxFrameBytes(),
      },
    })

    // Broadcast presence to all online linked peers
    this.broadcastPresence(id, kind, true)
  }

  private async failAuth(ws: WebSocket): Promise<void> {
    this.bump('auth_fail')
    this.sendError(ws, 'forbidden', 'authentication failed')
    ws.close(CloseCodes.AUTH_FAILED, 'authentication failed')
  }

  private getLinkedPeers(endpointId: string, kind: EndpointKind): Peer[] {
    const peers: Peer[] = []
    if (kind === 'host') {
      const rows = this.ctx.storage.sql.exec<{
        id: string
        kind: EndpointKind
        name: string
        last_seen_at: number | null
      }>(
        'SELECT e.id, e.kind, e.name, e.last_seen_at FROM links l ' +
          'JOIN endpoints e ON l.device_id = e.id ' +
          'WHERE l.host_id = ?1 AND e.revoked_at IS NULL',
        endpointId,
      )
      for (const row of rows) {
        const isOnline = this.findSocketsFor(row.id).some((s) => this.isAuthed(s))
        peers.push({
          id: row.id,
          kind: row.kind,
          name: row.name,
          online: isOnline,
          lastSeenAt: row.last_seen_at ?? 0,
        })
      }
    } else {
      const rows = this.ctx.storage.sql.exec<{
        id: string
        kind: EndpointKind
        name: string
        last_seen_at: number | null
      }>(
        'SELECT e.id, e.kind, e.name, e.last_seen_at FROM links l ' +
          'JOIN endpoints e ON l.host_id = e.id ' +
          'WHERE l.device_id = ?1 AND e.revoked_at IS NULL',
        endpointId,
      )
      for (const row of rows) {
        const isOnline = this.findSocketsFor(row.id).some((s) => this.isAuthed(s))
        peers.push({
          id: row.id,
          kind: row.kind,
          name: row.name,
          online: isOnline,
          lastSeenAt: row.last_seen_at ?? 0,
        })
      }
    }
    return peers
  }

  private broadcastPresence(endpointId: string, kind: EndpointKind, online: boolean): void {
    const peers = this.getLinkedPeers(endpointId, kind)
    const now = Date.now()
    const frame = {
      t: 'presence',
      v: RLY_VERSION,
      id: endpointId,
      kind,
      online,
      at: now,
    }

    for (const peer of peers) {
      if (peer.online) {
        for (const peerWs of this.findSocketsFor(peer.id)) {
          if (this.isAuthed(peerWs)) {
            this.sendJson(peerWs, frame)
          }
        }
      }
    }
  }

  private async onEnrollTicket(ws: WebSocket, att: Attachment, _frame: Record<string, unknown>, rid?: string): Promise<void> {
    if (att.kind !== 'host') {
      this.sendError(ws, 'forbidden', 'Only hosts can request enrollment tickets', rid)
      return
    }

    const ticketBytes = randomBytes(32)
    const ticketHash = await sha256(ticketBytes)
    const expiresAt = Date.now() + 600_000 // 10 minutes

    this.ctx.storage.sql.exec(
      'INSERT INTO tickets (ticket_hash, host_id, expires_at, used_at) VALUES (?1, ?2, ?3, NULL)',
      ticketHash,
      att.endpointId!,
      expiresAt,
    )

    this.sendJson(ws, {
      t: 'enroll.ticket.ok',
      rid,
      ticket: encodeBase64Url(ticketBytes),
      expiresAt,
    })
  }

  private async onEndpointList(ws: WebSocket, att: Attachment, _frame: Record<string, unknown>, rid?: string): Promise<void> {
    if (att.kind !== 'host') {
      this.sendError(ws, 'forbidden', 'Only hosts can request endpoint list', rid)
      return
    }

    const devices = this.getLinkedPeers(att.endpointId!, 'host')
    this.sendJson(ws, {
      t: 'endpoint.list.ok',
      rid,
      devices,
    })
  }

  private async onEndpointRevoke(ws: WebSocket, att: Attachment, frame: Record<string, unknown>, rid?: string): Promise<void> {
    const targetId = typeof frame.id === 'string' ? frame.id : ''
    if (!targetId) {
      this.sendError(ws, 'bad_request', 'Missing id to revoke', rid)
      return
    }

    // Host can revoke a linked device; Device can revoke itself
    let allowed = false
    if (att.kind === 'host') {
      allowed = this.links.has(`${att.endpointId}|${targetId}`)
    } else {
      allowed = att.endpointId === targetId
    }

    if (!allowed) {
      this.sendError(ws, 'forbidden', 'Cannot revoke unlinked endpoint', rid)
      return
    }

    const now = Date.now()
    this.ctx.storage.sql.exec('UPDATE endpoints SET revoked_at = ?1 WHERE id = ?2', now, targetId)

    // Close any active sockets of the revoked endpoint
    for (const targetWs of this.findSocketsFor(targetId)) {
      try {
        targetWs.close(CloseCodes.FORBIDDEN, 'endpoint revoked')
      } catch {
        // ignore
      }
    }

    this.sendJson(ws, {
      t: 'ok',
      rid,
    })

    const targetKind = targetId.startsWith('h_') ? 'host' : 'device'
    this.broadcastPresence(targetId, targetKind, false)
  }

  private async onPushToken(ws: WebSocket, att: Attachment, frame: Record<string, unknown>, rid?: string): Promise<void> {
    if (att.kind !== 'device') {
      this.sendError(ws, 'forbidden', 'Only devices can register push tokens', rid)
      return
    }

    const token = typeof frame.token === 'string' ? frame.token : null
    const hostOffline = frame.hostOffline === true ? 1 : 0
    this.ctx.storage.sql.exec(
      'UPDATE endpoints SET fcm_token = ?1, host_offline = ?2 WHERE id = ?3',
      token,
      hostOffline,
      att.endpointId!,
    )

    this.sendJson(ws, {
      t: 'ok',
      rid,
    })
  }

  /**
   * Handles a `push` frame from an authenticated host (RLY/1 §5, §8).
   * Fans out an FCM data-only message per destination device. STRICT INVARIANT:
   * `ct` is passed through opaquely — the relay never decrypts or inspects it
   * beyond the length check.
   */
  private async onPush(ws: WebSocket, att: Attachment, frame: Record<string, unknown>, rid?: string): Promise<void> {
    if (att.kind !== 'host') {
      this.sendError(ws, 'forbidden', 'Only hosts can send push notifications', rid)
      return
    }

    const ct = typeof frame.ct === 'string' ? frame.ct : null
    if (ct === null || ct.length > 3072) {
      this.sendError(ws, 'bad_request', 'ct must be a string of at most 3072 characters', rid)
      return
    }

    if (!Array.isArray(frame.to)) {
      this.sendError(ws, 'bad_request', 'to must be an array of device ids', rid)
      return
    }
    const to = frame.to.filter((d): d is string => typeof d === 'string')

    const collapse = typeof frame.collapse === 'string' ? frame.collapse : undefined
    const priority = frame.priority === 'high' || frame.priority === 'normal' ? frame.priority : undefined
    const ttl =
      typeof frame.ttl === 'number' && Number.isInteger(frame.ttl) && frame.ttl >= 0 && frame.ttl <= 86400
        ? frame.ttl
        : undefined

    const hostId = att.endpointId!
    const results: { id: string; status: 'sent' | 'no_token' | 'unregistered' | 'error' }[] = []

    for (const deviceId of to) {
      if (!this.links.has(`${hostId}|${deviceId}`)) {
        results.push({ id: deviceId, status: 'no_token' })
        continue
      }

      const rows = this.ctx.storage.sql.exec<{ revoked_at: number | null; fcm_token: string | null }>(
        'SELECT revoked_at, fcm_token FROM endpoints WHERE id = ?1',
        deviceId,
      ).toArray()
      const row = rows[0]
      if (row === undefined || row.revoked_at !== null || row.fcm_token === null) {
        results.push({ id: deviceId, status: 'no_token' })
        continue
      }

      const result = await sendFcmDataMessage(this.fcmEnv(), {
        token: row.fcm_token,
        data: { v: '1', h: hostId, ct },
        collapseKey: collapse,
        priority,
        ttl,
      })

      if (result.status === 'unregistered') {
        // Token cleanup (RLY/1 §8): FCM reported UNREGISTERED / INVALID_ARGUMENT.
        this.ctx.storage.sql.exec('UPDATE endpoints SET fcm_token = NULL WHERE id = ?1', deviceId)
        results.push({ id: deviceId, status: 'unregistered' })
      } else {
        results.push({ id: deviceId, status: result.status })
      }
    }

    this.sendJson(ws, {
      t: 'push.result',
      rid,
      results,
    })
  }

  /**
   * FCM env for the current Worker. `FCM_SERVICE_ACCOUNT_JSON` is a secret and
   * `FCM_ENDPOINT` is a test override; neither is in the generated Env type.
   */
  private fcmEnv(): FcmEnv {
    const env = this.env as unknown as { FCM_SERVICE_ACCOUNT_JSON?: unknown; FCM_ENDPOINT?: unknown }
    return {
      FCM_SERVICE_ACCOUNT_JSON: typeof env.FCM_SERVICE_ACCOUNT_JSON === 'string' ? env.FCM_SERVICE_ACCOUNT_JSON : undefined,
      FCM_ENDPOINT: typeof env.FCM_ENDPOINT === 'string' ? env.FCM_ENDPOINT : undefined,
    }
  }

  /**
   * Routes binary data frame according to RLY/1 §6.
   * STRICT INVARIANT: Never read or inspect payload bytes beyond the 28-byte header!
   */
  private async onData(ws: WebSocket, att: Attachment, bytes: Uint8Array): Promise<void> {
    this.bump('frames_in')
    const max = this.maxFrameBytes()

    if (bytes.length > max) {
      this.bump('frames_too_large')
      this.sendError(ws, 'too_large', `Frame exceeds ${max} bytes`)
      return
    }

    if (bytes.length < DATA_FRAME_HEADER_BYTES) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'Frame shorter than 28-byte header')
      return
    }

    if (!att.authed || !att.endpointId || !att.kind) {
      ws.close(CloseCodes.AUTH_FAILED, 'not authenticated')
      return
    }

    // Inspect ONLY header bytes (0..27)
    const version = bytes[0]
    const type = bytes[1]
    const reserved0 = bytes[2]
    const reserved1 = bytes[3]
    const dstKindByte = bytes[8]

    if (version !== 0x01 || type !== 0x01 || reserved0 !== 0x00 || reserved1 !== 0x00 || dstKindByte === undefined) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'Unsupported or malformed frame header')
      return
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const channel = view.getUint32(4)
    if (channel === 0) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'Channel must be non-zero')
      return
    }

    if (dstKindByte !== 0x01 && dstKindByte !== 0x02) {
      this.bump('frames_bad')
      this.sendError(ws, 'bad_request', 'Invalid destination peer kind')
      return
    }

    const dstKind: EndpointKind = dstKindByte === 0x01 ? 'host' : 'device'
    const dstRawPeerId = bytes.subarray(9, 25)
    const dstBase32 = encodeBase32(dstRawPeerId)
    const dstId = (dstKind === 'host' ? 'h_' : 'd_') + dstBase32

    if (dstKind === att.kind) {
      this.bump('not_linked')
      this.sendError(ws, 'not_linked', 'Destination not linked')
      return
    }

    const hostId = att.kind === 'host' ? att.endpointId : dstId
    const deviceId = att.kind === 'device' ? att.endpointId : dstId

    if (!this.links.has(`${hostId}|${deviceId}`)) {
      this.bump('not_linked')
      this.sendError(ws, 'not_linked', 'Destination not linked')
      return
    }

    const destSockets = this.findSocketsFor(dstId).filter((s) => this.isAuthed(s))
    if (destSockets.length === 0) {
      this.bump('peer_offline')
      this.sendError(ws, 'peer_offline', 'Destination peer is offline')
      return
    }

    // Rewrite ONLY the 17 peer bytes (peer kind + raw peer ID): destination → source (RLY/1 §6).
    // The payload bytes (offset 28+) are passed through 100% untouched.
    const routedFrame = new Uint8Array(bytes.length)
    routedFrame.set(bytes)
    routedFrame[8] = att.kind === 'host' ? 0x01 : 0x02
    const sourceRawId = decodeBase32(att.endpointId.slice(2))
    routedFrame.set(sourceRawId, 9)

    let forwarded = 0
    for (const dest of destSockets) {
      try {
        dest.send(routedFrame)
        forwarded += 1
        this.bump('ws_msg_out')
      } catch {
        // raced close
      }
    }

    if (forwarded === 0) {
      this.bump('peer_offline')
      this.sendError(ws, 'peer_offline', 'Destination peer is offline')
      return
    }

    this.bump('frames_routed')
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    this.bump('closes')
    const att = parseAttachment(ws)
    if (att !== null && !att.authed) {
      this.bump('pending_closed')
    }

    if (att !== null && att.authed && att.endpointId && att.kind) {
      const remaining = this.findSocketsFor(att.endpointId).filter((o) => o !== ws && this.isAuthed(o))
      if (remaining.length === 0) {
        // Last socket closed: broadcast presence offline
        this.broadcastPresence(att.endpointId, att.kind, false)

        if (att.kind === 'host') {
          const due = Date.now() + this.hostOfflineAlertMs()
          this.ctx.storage.sql.exec(
            'INSERT INTO tasks (k, v) VALUES (?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
            `${OFFLINE_TASK_PREFIX}${att.endpointId}`,
            JSON.stringify({ hostId: att.endpointId, due }),
          )
          this.bump('alarms_set')
          await this.armMinAlarm(due)
        }
      }
    }

    void code
    void reason
    void wasClean
    this.flushCounters()
  }

  private async cancelOfflineTask(hostId: string): Promise<void> {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM tasks WHERE k = ?1', `${OFFLINE_TASK_PREFIX}${hostId}`)
    const remaining = sql.exec<{ k: string }>('SELECT k FROM tasks WHERE k LIKE ?1', `${OFFLINE_TASK_PREFIX}%`).toArray()
    if (remaining.length === 0) await this.ctx.storage.deleteAlarm()
  }

  /**
   * Host-offline alert (RLY/1 §8): metadata-only push to every linked,
   * non-revoked device that opted in (`host_offline = 1`) and has a token.
   * Carries no content — the app renders it from its own host record.
   */
  private async dispatchHostOfflineAlert(hostId: string): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ fcm_token: string }>(
      'SELECT e.fcm_token FROM links l ' +
        'JOIN endpoints e ON l.device_id = e.id ' +
        'WHERE l.host_id = ?1 AND e.revoked_at IS NULL AND e.host_offline = 1 AND e.fcm_token IS NOT NULL',
      hostId,
    ).toArray()
    for (const row of rows) {
      await sendFcmDataMessage(this.fcmEnv(), {
        token: row.fcm_token,
        data: { v: '1', h: hostId, k: 'host_offline' },
      })
    }
  }

  override async alarm(): Promise<void> {
    this.bump('alarms_fired')
    const now = Date.now()

    // Auth timeout check
    for (const ws of this.ctx.getWebSockets()) {
      const att = parseAttachment(ws)
      if (att && !att.authed && now - att.connectedAt >= this.authTimeoutMs()) {
        try {
          ws.close(CloseCodes.AUTH_TIMEOUT, 'authentication timeout')
        } catch {
          // ignore
        }
        this.bump('auth_timeouts')
      }
    }

    // Host offline alert tasks (RLY/1 §8)
    const sql = this.ctx.storage.sql
    const taskRows = sql.exec<{ k: string; v: string }>(
      'SELECT k, v FROM tasks WHERE k LIKE ?1',
      `${OFFLINE_TASK_PREFIX}%`,
    ).toArray()
    let nextDue: number | null = null
    for (const taskRow of taskRows) {
      let task: { hostId?: unknown; due?: unknown } | null = null
      try {
        task = JSON.parse(taskRow.v) as { hostId?: unknown; due?: unknown }
      } catch {
        task = null
      }
      if (task === null || typeof task.hostId !== 'string' || typeof task.due !== 'number') {
        sql.exec('DELETE FROM tasks WHERE k = ?1', taskRow.k)
        continue
      }
      if (task.due > now) {
        if (nextDue === null || task.due < nextDue) nextDue = task.due
        continue
      }
      const stillOffline = !this.findSocketsFor(task.hostId).some((s) => this.isAuthed(s))
      if (stillOffline) await this.dispatchHostOfflineAlert(task.hostId)
      sql.exec('DELETE FROM tasks WHERE k = ?1', taskRow.k)
    }
    if (nextDue !== null) await this.armMinAlarm(nextDue)
    else await this.ctx.storage.deleteAlarm()
  }
}
