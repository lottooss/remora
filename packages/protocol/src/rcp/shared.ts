import { z } from 'zod'

/** Unsigned 32-bit identifier space used by envelope `id`, `sid`, and stream item numbers. */
export const U32Schema = z.number().int().min(0).max(4_294_967_295)

/** dsh durable event sequence: non-negative integer below 2^53 (RCP/1 §1). */
export const SeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

/** Timestamp: integer milliseconds since the Unix epoch (RCP/1 §1). */
export const EpochMsSchema = z.number().int().min(0)

/** Lowercase UUIDv4 as carried in `requestId` and pending-item ids (RCP/1 §1). */
export const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

/** Unpadded base64url (Crypto/1 §2). */
export const B64uSchema = z.string().regex(/^[A-Za-z0-9_-]+$/)

/** Opaque dsh session identifier. */
export const SessionIdSchema = z.string().min(1)

/** Opaque dsh workspace identifier. */
export const WorkspaceIdSchema = z.string().min(1)

/** Device identifier, `d_` prefixed (RCP/1 §1). */
export const DeviceIdSchema = z.string().regex(/^d_[A-Za-z0-9_-]+$/)

/** Host identifier, `h_` prefixed (RCP/1 §1). */
export const HostIdSchema = z.string().regex(/^h_[A-Za-z0-9_-]+$/)

/** Request id for exactly-once mutations (RCP/1 §1, AGENTS.md §1.7). */
export const RequestIdSchema = UuidSchema

/** Reference to a model selection (RCP/1 §5). */
export const ModelRefSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().optional(),
  })
  .passthrough()

/** Bounded preview of tool input or output (RCP/1 §5). */
export const PreviewSchema = z
  .object({
    text: z.string(),
    bytes: z.number().int().min(0),
    truncated: z.boolean(),
  })
  .passthrough()

export type ModelRef = z.infer<typeof ModelRefSchema>
export type Preview = z.infer<typeof PreviewSchema>
