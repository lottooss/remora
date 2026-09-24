import { z } from 'zod'
import { RcpErrorSchema, type RcpError } from './errors.ts'
import { U32Schema } from './shared.ts'

/**
 * RCP/1 envelope (spec §2). Unknown fields on incoming messages MUST be
 * ignored: every schema `passthrough()`es them instead of failing.
 */

/** Request in either direction; `p` is validated per-method against the registry. */
export interface RequestMessage {
  k: 'req'
  id: number
  m: string
  p?: Record<string, unknown>
}

/** Successful unary response or stream-open response (`{ sid }` for streams). */
export interface ResponseSuccessMessage {
  k: 'res'
  id: number
  ok: true
  r?: Record<string, unknown>
}

/** Failed response carrying an `RcpError`. */
export interface ResponseErrorMessage {
  k: 'res'
  id: number
  ok: false
  e: RcpError
}

/** Stream data item; `n` is 0,1,2,… per stream. */
export interface StreamItemMessage {
  k: 'item'
  sid: number
  n: number
  d: Record<string, unknown>
}

/** Stream closed by the server; optional after a client `cancel`. */
export interface StreamEndMessage {
  k: 'end'
  sid: number
  ok: boolean
  e?: RcpError
}

/** Stream cancelled by the client. */
export interface StreamCancelMessage {
  k: 'cancel'
  sid: number
}

/** Unsolicited notification; `e` names the event type, `d` its payload. */
export interface EventMessage {
  k: 'evt'
  e: string
  d: Record<string, unknown>
}

/** Discriminated union on `k` of every RCP/1 envelope shape. */
export type Message =
  | RequestMessage
  | ResponseSuccessMessage
  | ResponseErrorMessage
  | StreamItemMessage
  | StreamEndMessage
  | StreamCancelMessage
  | EventMessage

const PayloadSchema = z.record(z.string(), z.unknown())

export const RequestMessageSchema = z
  .object({
    k: z.literal('req'),
    id: U32Schema,
    m: z.string().min(1),
    p: PayloadSchema.optional(),
  })
  .passthrough()

export const ResponseSuccessMessageSchema = z
  .object({
    k: z.literal('res'),
    id: U32Schema,
    ok: z.literal(true),
    r: PayloadSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.e !== undefined) {
      ctx.addIssue({ code: 'custom', message: "'e' is not allowed when 'ok' is true", path: ['e'] })
    }
  })

export const ResponseErrorMessageSchema = z
  .object({
    k: z.literal('res'),
    id: U32Schema,
    ok: z.literal(false),
    e: RcpErrorSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.r !== undefined) {
      ctx.addIssue({ code: 'custom', message: "'r' is not allowed when 'ok' is false", path: ['r'] })
    }
  })

export const StreamItemMessageSchema = z
  .object({
    k: z.literal('item'),
    sid: U32Schema,
    n: z.number().int().min(0),
    d: PayloadSchema,
  })
  .passthrough()

export const StreamEndMessageSchema = z
  .object({
    k: z.literal('end'),
    sid: U32Schema,
    ok: z.boolean(),
    e: RcpErrorSchema.optional(),
  })
  .passthrough()

export const StreamCancelMessageSchema = z
  .object({
    k: z.literal('cancel'),
    sid: U32Schema,
  })
  .passthrough()

export const EventMessageSchema = z
  .object({
    k: z.literal('evt'),
    e: z.string().min(1),
    d: PayloadSchema,
  })
  .passthrough()

/**
 * Validates any untrusted envelope. A plain union (not `discriminatedUnion`)
 * because the two `res` variants share the discriminator `k: 'res'`, which zod
 * rejects in a discriminated union; matching stays deterministic via `ok`.
 */
export const MessageSchema = z.union([
  RequestMessageSchema,
  ResponseSuccessMessageSchema,
  ResponseErrorMessageSchema,
  StreamItemMessageSchema,
  StreamEndMessageSchema,
  StreamCancelMessageSchema,
  EventMessageSchema,
])
