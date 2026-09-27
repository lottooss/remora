/**
 * Per-device rate limits and stream concurrency control for Policy Guard (RCP/1 §11, blueprint §8.7).
 * - 20 req/s burst per device
 * - 5 mutating req/s per device
 * - 10 concurrent streams per device
 */
import { RCP_ERROR_CODES, createRcpError, type RcpError } from '@remora/protocol'

export const MAX_REQUESTS_PER_SECOND = 20
export const MAX_MUTATING_REQUESTS_PER_SECOND = 5
export const MAX_STREAMS_PER_DEVICE = 10

/** Methods that mutate state and consume mutating rate-limit tokens. */
export const MUTATING_METHODS = new Set([
  'sessions.prompt',
  'sessions.cancel',
  'sessions.create',
  'sessions.selectModel',
  'sessions.rename',
  'sessions.queue.update',
  'workspaces.create',
  'approvals.answer',
  'questions.answer',
  'devices.rename',
  'devices.revoke',
  'devices.rotateApprovalKey',
  'notify.prefs.set',
])

interface DeviceBucket {
  tokens: number
  lastRefillMs: number
  mutatingTokens: number
  lastMutatingRefillMs: number
}

function refill(current: number, capacity: number, lastRefillMs: number, now: number): number {
  if (now <= lastRefillMs) return current
  const elapsedSec = (now - lastRefillMs) / 1000
  return Math.min(capacity, current + elapsedSec * capacity)
}

function retryAfterMs(tokens: number, capacity: number): number {
  if (tokens >= 1) return 0
  const deficit = 1 - tokens
  return Math.ceil((deficit / capacity) * 1000)
}

export class DeviceRateLimiter {
  private readonly buckets = new Map<string, DeviceBucket>()
  private readonly activeStreams = new Map<string, number>()
  private readonly now: () => number

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? Date.now
  }

  isMutating(method: string): boolean {
    return MUTATING_METHODS.has(method)
  }

  getActiveStreams(deviceId: string): number {
    return this.activeStreams.get(deviceId) ?? 0
  }

  /**
   * Evaluates rate limits for an incoming request.
   * Consumes tokens on success; returns rate_limited RcpError if exhausted.
   */
  checkRequest(deviceId: string, method: string): { ok: boolean; error?: RcpError } {
    const now = this.now()
    let bucket = this.buckets.get(deviceId)
    if (!bucket) {
      bucket = {
        tokens: MAX_REQUESTS_PER_SECOND,
        lastRefillMs: now,
        mutatingTokens: MAX_MUTATING_REQUESTS_PER_SECOND,
        lastMutatingRefillMs: now,
      }
      this.buckets.set(deviceId, bucket)
    }

    // 1. General token bucket (20 req/s)
    bucket.tokens = refill(bucket.tokens, MAX_REQUESTS_PER_SECOND, bucket.lastRefillMs, now)
    bucket.lastRefillMs = now

    if (bucket.tokens < 1) {
      return {
        ok: false,
        error: createRcpError(
          RCP_ERROR_CODES.rate_limited,
          `Rate limit exceeded: more than ${MAX_REQUESTS_PER_SECOND} requests per second`,
          { limit: `${MAX_REQUESTS_PER_SECOND}/s` },
          retryAfterMs(bucket.tokens, MAX_REQUESTS_PER_SECOND),
        ),
      }
    }
    bucket.tokens -= 1

    // 2. Mutating token bucket (5 req/s)
    if (this.isMutating(method)) {
      bucket.mutatingTokens = refill(
        bucket.mutatingTokens,
        MAX_MUTATING_REQUESTS_PER_SECOND,
        bucket.lastMutatingRefillMs,
        now,
      )
      bucket.lastMutatingRefillMs = now

      if (bucket.mutatingTokens < 1) {
        return {
          ok: false,
          error: createRcpError(
            RCP_ERROR_CODES.rate_limited,
            `Mutating rate limit exceeded: more than ${MAX_MUTATING_REQUESTS_PER_SECOND} mutating requests per second`,
            { limit: `${MAX_MUTATING_REQUESTS_PER_SECOND}/s` },
            retryAfterMs(bucket.mutatingTokens, MAX_MUTATING_REQUESTS_PER_SECOND),
          ),
        }
      }
      bucket.mutatingTokens -= 1
    }

    return { ok: true }
  }

  /**
   * Attempts to acquire a stream slot for deviceId.
   * Returns a release callback on success, or rate_limited error if at capacity.
   */
  acquireStream(deviceId: string): { ok: boolean; error?: RcpError; release: () => void } {
    const count = this.activeStreams.get(deviceId) ?? 0
    if (count >= MAX_STREAMS_PER_DEVICE) {
      return {
        ok: false,
        error: createRcpError(
          RCP_ERROR_CODES.rate_limited,
          `Stream limit exceeded: maximum ${MAX_STREAMS_PER_DEVICE} concurrent streams per device`,
          { limit: `${MAX_STREAMS_PER_DEVICE} streams` },
          1000,
        ),
        release: () => {},
      }
    }

    this.activeStreams.set(deviceId, count + 1)
    let released = false
    const release = () => {
      if (!released) {
        released = true
        const current = this.activeStreams.get(deviceId) ?? 1
        if (current <= 1) {
          this.activeStreams.delete(deviceId)
        } else {
          this.activeStreams.set(deviceId, current - 1)
        }
      }
    }

    return { ok: true, release }
  }
}
