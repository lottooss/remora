import { z } from 'zod'

/**
 * Stable RCP/1 error code constants. Producers and matchers must use these
 * literals; adapters map upstream dsh codes onto them at the RCP boundary.
 */
export const RCP_ERROR_CODES = {
  invalid_request: 'invalid_request',
  method_not_found: 'method_not_found',
  invalid_params: 'invalid_params',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  not_found: 'not_found',
  conflict: 'conflict',
  rate_limited: 'rate_limited',
  too_large: 'too_large',
  cancelled: 'cancelled',
  internal_error: 'internal_error',
} as const

export type RcpErrorCode = (typeof RCP_ERROR_CODES)[keyof typeof RCP_ERROR_CODES]

/** Error payload carried by a failed `res` or a non-ok `end` (RCP/1 §3). */
export interface RcpError {
  code: string
  message: string
  retryAfterMs?: number
  details?: Record<string, unknown>
}

/** Zod schema for an untrusted `RcpError`; unknown fields are ignored. */
export const RcpErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    retryAfterMs: z.number().int().min(0).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

/**
 * Builds an `RcpError`. `details` is caller-supplied context for logs and
 * clients (never secrets or payload excerpts); `retryAfterMs` is advisory
 * backoff for `rate_limited` responses.
 */
export function createRcpError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryAfterMs?: number,
): RcpError {
  const error: RcpError = { code, message }
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs
  if (details !== undefined) error.details = details
  return error
}
