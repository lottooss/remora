/**
 * Live assistant stream coalescer (docs/specs/rcp-v1.md §5, blueprint §8.5):
 * Buffers raw assistant stream chunks from dsh and coalesces text and
 * reasoning deltas into `live.delta` items sent every `streamCoalesceMs`.
 * Emits `live.start` at turn/step start and `live.end` on settlement/abandonment.
 * Supports drop-under-backpressure for live items only (durable events are never dropped).
 */
import type { FollowItem } from '@remora/protocol'

export interface LiveCoalescerOptions {
  /** Maximum delay between emitted live deltas in milliseconds (default 50 ms). */
  streamCoalesceMs?: number
  /** Sink where formatted FollowItem frames are pushed. */
  emit: (item: FollowItem) => Promise<boolean | void> | boolean | void
}

interface ActiveAttempt {
  attemptId: string
  afterSeq: number
  nextIndex: number
  bufferedText: string
  bufferedReasoning: string
  flushTimer: ReturnType<typeof setTimeout> | null
  isFlushing: boolean
  droppedUnderBackpressure: boolean
}

export class LiveCoalescer {
  private readonly coalesceMs: number
  private readonly emit: (item: FollowItem) => Promise<boolean | void> | boolean | void
  private activeAttempt: ActiveAttempt | null = null
  private disposed = false

  constructor(options: LiveCoalescerOptions) {
    this.coalesceMs = options.streamCoalesceMs ?? 50
    this.emit = options.emit
  }

  /**
   * Ingests one dsh assistant-stream frame (`start`, `chunk`, or `end`).
   */
  async handleFrame(frame: unknown): Promise<void> {
    if (this.disposed || typeof frame !== 'object' || frame === null) return
    const f = frame as Record<string, unknown>
    const type = f['type']

    if (type === 'start') {
      await this.handleStart(f)
    } else if (type === 'chunk') {
      this.handleChunk(f)
    } else if (type === 'end') {
      await this.handleEnd(f)
    }
  }

  private async handleStart(frame: Record<string, unknown>): Promise<void> {
    // If a previous attempt was left open, settle or abandon it first
    if (this.activeAttempt) {
      await this.flushAttempt(this.activeAttempt)
      await this.safeEmit({
        type: 'live.end',
        attempt: this.activeAttempt.attemptId,
        outcome: 'abandoned',
      })
      this.clearTimer(this.activeAttempt)
    }

    const attemptId = typeof frame['attemptId'] === 'string' ? frame['attemptId'] : 'attempt_0'
    const afterSeq = typeof frame['startedAfterSeq'] === 'number' ? frame['startedAfterSeq'] : 0

    const attempt: ActiveAttempt = {
      attemptId,
      afterSeq,
      nextIndex: 0,
      bufferedText: '',
      bufferedReasoning: '',
      flushTimer: null,
      isFlushing: false,
      droppedUnderBackpressure: false,
    }
    this.activeAttempt = attempt

    await this.safeEmit({
      type: 'live.start',
      attempt: attemptId,
      afterSeq,
    })
  }

  private handleChunk(frame: Record<string, unknown>): void {
    const attempt = this.activeAttempt
    if (!attempt) return

    const chunk = frame['chunk'] as Record<string, unknown> | undefined
    if (typeof chunk !== 'object' || chunk === null) return

    const chunkType = chunk['type']
    if (chunkType === 'text-delta' && typeof chunk['text'] === 'string') {
      attempt.bufferedText += chunk['text']
    } else if (chunkType === 'reasoning-delta' && typeof chunk['text'] === 'string') {
      attempt.bufferedReasoning += chunk['text']
    }

    // Schedule delayed flush if not already pending
    if (attempt.flushTimer === null && (attempt.bufferedText || attempt.bufferedReasoning)) {
      attempt.flushTimer = setTimeout(() => {
        attempt.flushTimer = null
        void this.flushAttempt(attempt)
      }, this.coalesceMs)
    }
  }

  private async handleEnd(frame: Record<string, unknown>): Promise<void> {
    const attempt = this.activeAttempt
    if (!attempt) return

    this.clearTimer(attempt)
    await this.flushAttempt(attempt)

    const outcomeObj = frame['outcome'] as Record<string, unknown> | undefined
    const isCommitted = outcomeObj?.['kind'] === 'committed'
    const outcome: 'settled' | 'abandoned' = isCommitted ? 'settled' : 'abandoned'

    await this.safeEmit({
      type: 'live.end',
      attempt: attempt.attemptId,
      outcome,
    })

    this.activeAttempt = null
  }

  private async flushAttempt(attempt: ActiveAttempt): Promise<void> {
    if (attempt.isFlushing) return
    const text = attempt.bufferedText
    const reasoning = attempt.bufferedReasoning

    if (!text && !reasoning) return

    attempt.isFlushing = true
    attempt.bufferedText = ''
    attempt.bufferedReasoning = ''

    const item: FollowItem = {
      type: 'live.delta',
      attempt: attempt.attemptId,
      index: attempt.nextIndex++,
      ...(text ? { text } : {}),
      ...(reasoning ? { reasoning } : {}),
    }

    try {
      const delivered = await this.safeEmit(item)
      if (delivered === false) {
        attempt.droppedUnderBackpressure = true
      }
    } finally {
      attempt.isFlushing = false
    }
  }

  private async safeEmit(item: FollowItem): Promise<boolean | void> {
    if (this.disposed) return false
    try {
      return await this.emit(item)
    } catch {
      return false
    }
  }

  private clearTimer(attempt: ActiveAttempt): void {
    if (attempt.flushTimer !== null) {
      clearTimeout(attempt.flushTimer)
      attempt.flushTimer = null
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.activeAttempt) {
      this.clearTimer(this.activeAttempt)
      this.activeAttempt = null
    }
  }
}
