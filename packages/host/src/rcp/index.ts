/**
 * RCP/1 server (docs/specs/rcp-v1.md §2–§4, §11): validates untrusted
 * envelopes, dispatches registered methods, tracks stream subscriptions and
 * cancellation, and enforces the per-device size, rate, and stream limits.
 * Framing and encryption live in `src/channel`; dsh access lands in
 * `src/adapter` and `src/interaction/dsh-*.ts`.
 */
import { ENDPOINT_ID_PREFIX } from '@remora/crypto'
import {
  MAX_RCP_MESSAGE_BYTES,
  MessageSchema,
  RCP_ERROR_CODES,
  RCP_VERSION,
  RcpErrorSchema,
  createRcpError,
  getRcpMethod,
  type RcpError,
  type RequestMessage,
} from '@remora/protocol'

/** Requests per second (burst) one device may send (RCP/1 §11). */
const MAX_REQUESTS_PER_SECOND = 20

/** Mutating requests per second one device may send (RCP/1 §11). */
const MAX_MUTATING_REQUESTS_PER_SECOND = 5

/** Concurrent streams one device may hold open (RCP/1 §11). */
const MAX_STREAMS_PER_DEVICE = 10

/** Version announced by `hello` until the bundle carries the real one. */
const HOST_VERSION = '1.0.0'

/** Largest u32 id accepted in an envelope (RCP/1 §2). */
const U32_MAX = 0xffffffff

/** Per-request context handed to handlers; produced by the secure channel. */
export interface RcpContext {
  deviceId: string
  channelId: number
}

/** A method handler. `params` is the raw, unvalidated `p` of the request. */
export type RcpHandler = (params: unknown, ctx: RcpContext) => Promise<unknown>

/** Live status `host.status` reports; absent → fail-closed defaults. */
export interface HostStatusProvider {
  isRelayConnected: () => boolean
  getPairedDevicesCount: () => number
}

export interface RcpServerOptions {
  hostId: string
  hostName: string
  statusProvider?: HostStatusProvider
  /** Clock injection point so limits and uptime stay deterministic in tests. */
  now?: () => number
}

/** A stream the server opened for a device (RCP/1 §2). */
export interface RcpStream {
  readonly sid: number
  readonly deviceId: string
  readonly channelId: number
  readonly method: string
  readonly openedAt: number
  /** Aborted on `cancel` or when the device's channel closes. */
  readonly signal: AbortSignal
}

/**
 * Handler-thrown error that is safe to show the phone (RCP/1 §3). Any other
 * thrown value becomes `internal_error` without leaking its message.
 */
export class RcpMethodError extends Error {
  readonly rcpError: RcpError

  constructor(rcpError: RcpError) {
    super(rcpError.message)
    this.name = 'RcpMethodError'
    this.rcpError = rcpError
  }
}

interface RateLimitBucket {
  tokens: number
  lastRefillMs: number
  mutatingTokens: number
  lastMutatingRefillMs: number
}

interface TrackedStream extends RcpStream {
  readonly controller: AbortController
}

export class RcpServer {
  private readonly handlers = new Map<string, RcpHandler>()
  private readonly rateLimits = new Map<string, RateLimitBucket>()
  private readonly streams = new Map<number, TrackedStream>()
  private readonly streamsByDevice = new Map<string, Set<number>>()
  private readonly now: () => number
  private readonly startTime: number
  private nextSid = 1

  constructor(private readonly options: RcpServerOptions) {
    this.now = options.now ?? Date.now
    this.startTime = this.now()
    this.registerCoreMethods()
  }

  /**
   * Registers a handler under a wire method name. Whether the method streams
   * is decided by the protocol registry, not by the handler: for a stream
   * method the handler returns the open payload and the server adds `sid`.
   */
  registerMethod(name: string, handler: RcpHandler): void {
    this.handlers.set(name, handler)
  }

  /** Streams `deviceId` holds open across all of its channels. */
  activeStreamCount(deviceId: string): number {
    return this.streamsByDevice.get(deviceId)?.size ?? 0
  }

  /** Subscription for `sid`, or `undefined` once cancelled or released. */
  getStream(sid: number): RcpStream | undefined {
    return this.streams.get(sid)
  }

  /**
   * Releases every stream a device held on a channel that is gone; otherwise
   * abandoned streams would count against its cap forever (RCP/1 §11).
   */
  closeChannel(deviceId: string, channelId: number): void {
    // Deleting the visited entry during iteration is safe for Map iterators.
    for (const stream of this.streams.values()) {
      if (stream.deviceId === deviceId && stream.channelId === channelId) {
        this.releaseStream(stream)
      }
    }
  }

  /**
   * Handles one message from a device: returns the JSON reply to send back, or
   * `null` when the message must be dropped without a reply. Never rejects, so
   * the channel layer never sees a failed dispatch.
   */
  async handleMessage(rawMessage: string, ctx: RcpContext): Promise<string | null> {
    try {
      return await this.dispatch(rawMessage, ctx)
    } catch {
      return null
    }
  }

  private async dispatch(rawMessage: string, ctx: RcpContext): Promise<string | null> {
    if (!ctx.deviceId.startsWith(ENDPOINT_ID_PREFIX.device)) return null
    if (!Number.isInteger(ctx.channelId) || ctx.channelId < 0 || ctx.channelId > U32_MAX) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(rawMessage)
    } catch {
      // Unparseable: there is no id to answer, so drop (fail closed).
      return null
    }

    // Upstream transports already bound message size (SC/1 48 KiB, relay 64 KiB
    // frames); this is defense in depth for anything reaching us directly.
    if (utf8ByteLength(rawMessage) > MAX_RCP_MESSAGE_BYTES) {
      const id = extractRequestId(parsed)
      if (id === null) return null
      return this.encodeError(
        id,
        createRcpError(RCP_ERROR_CODES.too_large, `message exceeds ${MAX_RCP_MESSAGE_BYTES} bytes`),
      )
    }

    const validated = MessageSchema.safeParse(parsed)
    if (!validated.success) {
      const id = extractRequestId(parsed)
      if (id === null) return null
      return this.encodeError(
        id,
        createRcpError(RCP_ERROR_CODES.invalid_request, 'invalid RCP/1 envelope'),
      )
    }

    const message = validated.data
    if (message.k === 'cancel') {
      this.cancelStream(message.sid, ctx)
      return null
    }
    // The host never answers res/item/evt coming from a device.
    if (message.k !== 'req') return null
    return this.handleRequest(toRequestMessage(message), ctx)
  }

  private async handleRequest(req: RequestMessage, ctx: RcpContext): Promise<string> {
    const method = getRcpMethod(req.m)
    const limited = this.takeRateLimitToken(ctx.deviceId, method?.mutating === true)
    if (limited) return this.encodeError(req.id, limited)

    const handler = this.handlers.get(req.m)
    if (!handler) {
      return this.encodeError(
        req.id,
        createRcpError(RCP_ERROR_CODES.method_not_found, `method '${req.m}' is not available`),
      )
    }

    const isStream = method?.kind === 'stream'
    if (isStream && this.activeStreamCount(ctx.deviceId) >= MAX_STREAMS_PER_DEVICE) {
      return this.encodeError(
        req.id,
        createRcpError(
          RCP_ERROR_CODES.rate_limited,
          `device already holds ${MAX_STREAMS_PER_DEVICE} streams`,
          { maxStreams: MAX_STREAMS_PER_DEVICE },
          1_000,
        ),
      )
    }

    let result: unknown
    try {
      result = await handler(req.p, ctx)
    } catch (err: unknown) {
      return this.encodeError(req.id, toRcpError(err))
    }

    if (!isStream) return this.encodeUnarySuccess(req.id, result)
    return this.openStream(req, ctx, result)
  }

  private openStream(req: RequestMessage, ctx: RcpContext, result: unknown): string {
    const sid = this.allocateSid()
    const payload = { ...(isRecord(result) ? result : {}), sid }
    const encoded = this.encodeSuccess(req.id, payload)
    // Only track a stream the phone actually learned about.
    if (typeof encoded !== 'string') return this.encodeError(req.id, encoded)

    const controller = new AbortController()
    const stream: TrackedStream = {
      sid,
      deviceId: ctx.deviceId,
      channelId: ctx.channelId,
      method: req.m,
      openedAt: this.now(),
      controller,
      signal: controller.signal,
    }
    this.streams.set(sid, stream)
    const deviceStreams = this.streamsByDevice.get(stream.deviceId) ?? new Set<number>()
    deviceStreams.add(sid)
    this.streamsByDevice.set(stream.deviceId, deviceStreams)
    return encoded
  }

  /** `cancel` for an unknown or foreign stream is ignored (RCP/1 §2). */
  private cancelStream(sid: number, ctx: RcpContext): void {
    const stream = this.streams.get(sid)
    if (!stream) return
    if (stream.deviceId !== ctx.deviceId || stream.channelId !== ctx.channelId) return
    this.releaseStream(stream)
  }

  private releaseStream(stream: TrackedStream): void {
    this.streams.delete(stream.sid)
    const deviceStreams = this.streamsByDevice.get(stream.deviceId)
    deviceStreams?.delete(stream.sid)
    if (deviceStreams && deviceStreams.size === 0) {
      this.streamsByDevice.delete(stream.deviceId)
    }
    stream.controller.abort()
  }

  private allocateSid(): number {
    let sid = this.nextSid
    while (this.streams.has(sid)) {
      sid = sid >= U32_MAX ? 1 : sid + 1
    }
    this.nextSid = sid >= U32_MAX ? 1 : sid + 1
    return sid
  }

  private takeRateLimitToken(deviceId: string, mutating: boolean): RcpError | null {
    const now = this.now()
    let bucket = this.rateLimits.get(deviceId)
    if (!bucket) {
      bucket = {
        tokens: MAX_REQUESTS_PER_SECOND,
        lastRefillMs: now,
        mutatingTokens: MAX_MUTATING_REQUESTS_PER_SECOND,
        lastMutatingRefillMs: now,
      }
      this.rateLimits.set(deviceId, bucket)
    }

    bucket.tokens = refill(bucket.tokens, MAX_REQUESTS_PER_SECOND, bucket.lastRefillMs, now)
    bucket.lastRefillMs = now
    if (bucket.tokens < 1) {
      return createRcpError(
        RCP_ERROR_CODES.rate_limited,
        `more than ${MAX_REQUESTS_PER_SECOND} requests per second`,
        { limit: `${MAX_REQUESTS_PER_SECOND}/s` },
        retryAfterMs(bucket.tokens, MAX_REQUESTS_PER_SECOND),
      )
    }
    bucket.tokens -= 1

    if (!mutating) return null

    bucket.mutatingTokens = refill(
      bucket.mutatingTokens,
      MAX_MUTATING_REQUESTS_PER_SECOND,
      bucket.lastMutatingRefillMs,
      now,
    )
    bucket.lastMutatingRefillMs = now
    if (bucket.mutatingTokens < 1) {
      return createRcpError(
        RCP_ERROR_CODES.rate_limited,
        `more than ${MAX_MUTATING_REQUESTS_PER_SECOND} mutating requests per second`,
        { limit: `${MAX_MUTATING_REQUESTS_PER_SECOND}/s` },
        retryAfterMs(bucket.mutatingTokens, MAX_MUTATING_REQUESTS_PER_SECOND),
      )
    }
    bucket.mutatingTokens -= 1
    return null
  }

  private registerCoreMethods(): void {
    this.registerMethod('hello', async () => ({
      host: {
        id: this.options.hostId,
        name: this.options.hostName,
        version: HOST_VERSION,
      },
      rcp: [RCP_VERSION],
      features: ['sessions', 'files', 'diffs'],
      policy: { maxMessageBytes: MAX_RCP_MESSAGE_BYTES },
    }))

    this.registerMethod('ping', async (params) => {
      const t = isRecord(params) ? params.t : undefined
      if (typeof t !== 'number') {
        throw new RcpMethodError(
          createRcpError(RCP_ERROR_CODES.invalid_params, 'ping requires params.t: number'),
        )
      }
      return { t, hostTime: this.now() }
    })

    this.registerMethod('host.status', async () => ({
      relayConnected: this.options.statusProvider?.isRelayConnected() ?? false,
      pairedDevicesCount: this.options.statusProvider?.getPairedDevicesCount() ?? 0,
      uptimeMs: this.now() - this.startTime,
    }))
  }

  private encodeUnarySuccess(id: number, result: unknown): string {
    const encoded = this.encodeSuccess(id, result)
    return typeof encoded === 'string' ? encoded : this.encodeError(id, encoded)
  }

  /** Encodes a `res{ok:true}`; on an unusable result returns the error to send. */
  private encodeSuccess(id: number, result: unknown): string | RcpError {
    if (!isRecord(result)) {
      return createRcpError(RCP_ERROR_CODES.internal_error, 'handler returned a non-object result')
    }
    let json: string
    try {
      json = JSON.stringify({ k: 'res', id, ok: true, r: result })
    } catch {
      return createRcpError(RCP_ERROR_CODES.internal_error, 'handler returned a non-serializable result')
    }
    if (utf8ByteLength(json) > MAX_RCP_MESSAGE_BYTES) {
      return createRcpError(
        RCP_ERROR_CODES.too_large,
        `response exceeds ${MAX_RCP_MESSAGE_BYTES} bytes`,
      )
    }
    return json
  }

  private encodeError(id: number, error: RcpError): string {
    return JSON.stringify({ k: 'res', id, ok: false, e: error })
  }
}

/**
 * Rebuilds a validated request as `RequestMessage`: zod's passthrough typing
 * carries `p?: … | undefined`, which `exactOptionalPropertyTypes` rejects on
 * the protocol type.
 */
function toRequestMessage(
  req: { id: number; m: string; p?: Record<string, unknown> | undefined },
): RequestMessage {
  return req.p === undefined
    ? { k: 'req', id: req.id, m: req.m }
    : { k: 'req', id: req.id, m: req.m, p: req.p }
}

/** Refined handler failure: a client-visible `RcpError`, else `internal_error`. */
function toRcpError(err: unknown): RcpError {
  const candidate = (err as { rcpError?: unknown } | null | undefined)?.rcpError
  const validated = candidate === undefined ? null : RcpErrorSchema.safeParse(candidate)
  if (validated !== null && validated.success) {
    return createRcpError(
      validated.data.code,
      validated.data.message,
      validated.data.details,
      validated.data.retryAfterMs,
    )
  }
  // Never surface a raw exception: its message may carry paths or payload.
  const cause = err instanceof Error ? err.name : typeof err
  return createRcpError(RCP_ERROR_CODES.internal_error, 'internal error', { cause })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** u32 `id` of a request-shaped envelope, or `null` when it cannot be trusted. */
function extractRequestId(parsed: unknown): number | null {
  if (!isRecord(parsed) || parsed.k !== 'req') return null
  const id = parsed.id
  if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > U32_MAX) return null
  return id
}

/**
 * UTF-8 size of `text`. UTF-8 never uses fewer bytes than UTF-16 code units, so
 * input that is already too long in code units short-circuits without encoding.
 */
function utf8ByteLength(text: string): number {
  if (text.length > MAX_RCP_MESSAGE_BYTES) return text.length
  return new TextEncoder().encode(text).length
}

function refill(tokens: number, capacity: number, lastMs: number, now: number): number {
  const elapsedMs = Math.max(0, now - lastMs)
  return Math.min(capacity, tokens + (elapsedMs / 1000) * capacity)
}

function retryAfterMs(tokens: number, capacity: number): number {
  return Math.max(1, Math.ceil(((1 - tokens) / capacity) * 1000))
}
