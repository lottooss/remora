/**
 * Fake of the relay — the OTHER side of the host's relay boundary — for the
 * P7-H3 enrollment tests (docs/tasks/P7-H3.md). It is a real HTTP server on a
 * loopback port that mirrors the RLY/1 surface the host touches at startup:
 *
 * - `POST /v1/enroll/host` (relay-v1.md §4.1): bearer secret compared against
 *   the configured one (401 otherwise), body `{v, relayPub, name, platform}`,
 *   reply `{v: 1, id}` with the id derived from `relayPub` (crypto-v1.md §2);
 * - `GET /v1/connect` WebSocket upgrade (relay-v1.md §3): challenge → auth →
 *   `ready` for an enrolled host whose signature verifies, or an `error`
 *   frame plus close 4403 for an endpoint the relay does not know — exactly
 *   what the real relay (apps/relay/src/account-hub.ts) does, which is how
 *   "connect before enroll" fails against it.
 *
 * The WebSocket side is a minimal RFC 6455 server written against node:http
 * (text, close, and ping frames only; no extensions) because the host package
 * has no `ws` typings; it exists only to drive the host's real RelayLink.
 * Only the endpoint table is modelled — no routing, presence, or pushes.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { decodeBase64Url, deriveEndpointId, encodeBase64Url, verifyRelayChallenge } from '@remora/crypto'

/** RFC 6455 §1.3 handshake GUID. */
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const RLY_SUBPROTOCOL = 'remora.rly.v1'

const OPCODE_TEXT = 0x1
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** One `POST /v1/enroll/host` request as the fake relay received it. */
export interface FakeEnrollRequest {
  readonly authorization: string | undefined
  readonly body: unknown
  /** Monotonic order across enroll and connect events, for ordering assertions. */
  readonly sequence: number
}

/** One `GET /v1/connect` upgrade and how the fake relay answered its auth frame. */
export interface FakeConnectAttempt {
  readonly sequence: number
  outcome: 'pending' | 'ready' | 'forbidden' | 'auth-failed'
  endpointId?: string
}

export interface FakeRelayOptions {
  /** The relay's `REMORA_ENROLL_SECRET`; enrollment requires `Bearer <secret>`. */
  readonly enrollSecret: string
  /**
   * Optional reply override per enroll attempt (1-based): returning a reply
   * answers that attempt with it instead of processing the request;
   * `undefined` processes it normally.
   */
  readonly enrollResponseFor?: (attempt: number) => { status: number; body: unknown } | undefined
  /** Bind to this port instead of an ephemeral one (to come up on a port the host already dials). */
  readonly port?: number
}

export interface FakeRelay {
  /** `http://127.0.0.1:<port>` — the origin the host is configured with. */
  readonly origin: string
  readonly port: number
  readonly enrollRequests: readonly FakeEnrollRequest[]
  readonly connectAttempts: readonly FakeConnectAttempt[]
  /** Host ids the relay currently knows (enrolled and not forgotten). */
  readonly enrolledHostIds: ReadonlySet<string>
  /** Drops the endpoint table, as a relay redeployed with fresh storage would. */
  forgetEndpoints(): void
  close(): Promise<void>
}

/** Encodes one unmasked server-to-client frame (RFC 6455 §5.2). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  return Buffer.concat([header, payload])
}

/** One decoded client frame plus the number of bytes it occupied. */
interface DecodedFrame {
  opcode: number
  payload: Buffer
  size: number
}

/** Decodes one (masked) client frame from the front of `buffer`, or `null` when incomplete. */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) return null
  const first = buffer.readUInt8(0)
  const second = buffer.readUInt8(1)
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  const mask = buffer.subarray(offset, offset + maskLength)
  offset += maskLength
  const payload = Buffer.from(buffer.subarray(offset, offset + length))
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index)
    }
  }
  return { opcode, payload, size: offset + length }
}

function sendText(socket: Socket, value: unknown): void {
  if (!socket.writable) return
  socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(JSON.stringify(value), 'utf8')))
}

function sendClose(socket: Socket, code: number, reason: string): void {
  if (!socket.writable) return
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
  payload.writeUInt16BE(code, 0)
  payload.write(reason, 2)
  socket.write(encodeFrame(OPCODE_CLOSE, payload))
  socket.end()
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

/** Starts the fake relay on a loopback port; `close()` it in the test's cleanup. */
export async function startFakeRelay(options: FakeRelayOptions): Promise<FakeRelay> {
  const enrollRequests: FakeEnrollRequest[] = []
  const connectAttempts: FakeConnectAttempt[] = []
  /** host id → Ed25519 relay public key */
  const endpoints = new Map<string, Uint8Array>()
  const sockets = new Set<Socket>()
  let sequence = 0

  const handleEnroll = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const text = await readBody(request)
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    enrollRequests.push({ authorization: request.headers.authorization, body, sequence: (sequence += 1) })
    const forced = options.enrollResponseFor?.(enrollRequests.length)
    if (forced !== undefined) {
      sendJson(response, forced.status, forced.body)
      return
    }
    if (request.headers.authorization !== `Bearer ${options.enrollSecret}`) {
      sendJson(response, 401, { error: 'unauthorized', message: 'Invalid enrollment secret' })
      return
    }
    const relayPub =
      typeof body === 'object' && body !== null && 'relayPub' in body && typeof body.relayPub === 'string'
        ? body.relayPub
        : undefined
    const version = typeof body === 'object' && body !== null && 'v' in body ? body.v : undefined
    if (version !== 1 || relayPub === undefined) {
      sendJson(response, 400, { error: 'bad_request', message: 'Invalid enrollment payload' })
      return
    }
    let publicKey: Uint8Array
    try {
      publicKey = decodeBase64Url(relayPub)
      if (publicKey.length !== 32) throw new Error('length')
    } catch {
      sendJson(response, 400, { error: 'bad_request', message: 'Invalid relayPub' })
      return
    }
    const id = deriveEndpointId('h_', publicKey)
    endpoints.set(id, publicKey)
    sendJson(response, 200, { v: 1, id })
  }

  const handleAuth = (socket: Socket, attempt: FakeConnectAttempt, nonce: string, frame: unknown): void => {
    const id = typeof frame === 'object' && frame !== null && 'id' in frame && typeof frame.id === 'string' ? frame.id : ''
    const sig = typeof frame === 'object' && frame !== null && 'sig' in frame && typeof frame.sig === 'string' ? frame.sig : ''
    attempt.endpointId = id
    const publicKey = endpoints.get(id)
    if (publicKey === undefined) {
      attempt.outcome = 'forbidden'
      sendText(socket, { t: 'error', v: 1, code: 'forbidden', message: 'Endpoint unknown or revoked' })
      sendClose(socket, 4403, 'endpoint revoked or unknown')
      return
    }
    let valid = false
    try {
      valid = verifyRelayChallenge(publicKey, nonce, decodeBase64Url(sig))
    } catch {
      valid = false
    }
    if (!valid) {
      attempt.outcome = 'auth-failed'
      sendClose(socket, 4401, 'authentication failed')
      return
    }
    attempt.outcome = 'ready'
    sendText(socket, { t: 'ready', v: 1, id, peers: [], limits: {} })
  }

  const handleUpgrade = (request: IncomingMessage, socket: Socket): void => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
    const key = request.headers['sec-websocket-key']
    const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map((item) => item.trim())
    if (new URL(request.url ?? '/', 'http://fake').pathname !== '/v1/connect' || typeof key !== 'string' || !protocols.includes(RLY_SUBPROTOCOL)) {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
      return
    }
    const attempt: FakeConnectAttempt = { sequence: (sequence += 1), outcome: 'pending' }
    connectAttempts.push(attempt)
    const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${RLY_SUBPROTOCOL}\r\n\r\n`,
    )
    const nonce = encodeBase64Url(randomBytes(32))
    sendText(socket, { t: 'challenge', v: 1, nonce, time: Date.now() })

    let pending = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      for (let frame = decodeFrame(pending); frame !== null; frame = decodeFrame(pending)) {
        pending = pending.subarray(frame.size)
        if (frame.opcode === OPCODE_CLOSE) {
          sendClose(socket, 1000, 'bye')
          return
        }
        if (frame.opcode === OPCODE_PING) {
          if (socket.writable) socket.write(encodeFrame(OPCODE_PONG, frame.payload))
          continue
        }
        if (frame.opcode !== OPCODE_TEXT) continue
        let message: unknown
        try {
          message = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        const type = typeof message === 'object' && message !== null && 't' in message ? message.t : undefined
        if (type === 'auth' && attempt.outcome === 'pending') handleAuth(socket, attempt, nonce, message)
        else if (type === 'ping') sendText(socket, { t: 'pong' })
      }
    })
  }

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fake').pathname
    if (request.method === 'POST' && path === '/v1/enroll/host') {
      handleEnroll(request, response).catch(() => sendJson(response, 500, { error: 'internal' }))
      return
    }
    if (request.method === 'GET' && path === '/v1/health') {
      sendJson(response, 200, { ok: true, v: 1 })
      return
    }
    sendJson(response, 404, { error: 'not_found' })
  })
  server.on('upgrade', handleUpgrade)
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address()
      if (address !== null && typeof address === 'object') resolve(address.port)
      else reject(new Error('fake relay: no listening address'))
    })
  })

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    enrollRequests,
    connectAttempts,
    get enrolledHostIds(): ReadonlySet<string> {
      return new Set(endpoints.keys())
    },
    forgetEndpoints(): void {
      endpoints.clear()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
