/**
 * Pending interaction registry (RCP/1 §8, ADR-0008).
 * Tracks pending approvals and questions, manages single-use resolution,
 * and fans out baseline and delta updates to subscribed device streams.
 */

export interface PendingApproval {
  kind: 'approval'
  id: string
  sessionId: string
  sessionTitle: string | null
  toolName: string
  callId?: string | undefined
  reason?: string | undefined
  preview: { text: string; json: string }
  argsDigest: string
  risk: 'normal' | 'high'
  requiresSignature: boolean
  createdAt: number
  expiresAt: number
  resolved?: boolean | undefined
  resolution?: {
    outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    by: 'phone' | 'pc' | 'system'
    deviceId?: string | undefined
  } | undefined
}

export interface PendingQuestion {
  kind: 'question'
  id: string
  sessionId: string
  sessionTitle: string | null
  questions: Array<{
    id: string
    question: string
    detail?: string | undefined
    header?: string | undefined
    options?: Array<{ label: string; description?: string | undefined }> | undefined
    multiSelect?: boolean | undefined
    intent?: { kind: 'plan-review'; approve: string } | undefined
  }>
  createdAt: number
  expiresAt: number
  resolved?: boolean | undefined
  resolution?: {
    outcome: string
    by: 'phone' | 'pc' | 'system'
    deviceId?: string | undefined
    answers?: Array<{ id: string; selected: string[]; custom?: string | undefined }> | undefined
  } | undefined
}

export type PendingItem = PendingApproval | PendingQuestion

export type InteractionDeltaEvent =
  | { type: 'requested'; pending: PendingItem }
  | { type: 'resolved'; id: string; outcome: string; by: 'phone' | 'pc' | 'system'; deviceId?: string | undefined }

export class PendingRegistry {
  private readonly items = new Map<string, PendingItem>()
  private readonly subscribers = new Set<(event: InteractionDeltaEvent) => void>()
  private readonly resolveListeners = new Map<string, Array<(resolution: unknown) => void>>()

  add(item: PendingItem): void {
    this.items.set(item.id, item)
    this.emit({ type: 'requested', pending: item })
  }

  get(id: string): PendingItem | undefined {
    return this.items.get(id)
  }

  list(): PendingItem[] {
    return Array.from(this.items.values()).filter((item) => !item.resolved)
  }

  resolveApproval(
    id: string,
    outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable',
    by: 'phone' | 'pc' | 'system',
    deviceId?: string | undefined,
  ): { accepted: boolean; final: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'; by: 'phone' | 'pc' | 'system' } {
    const item = this.items.get(id)
    if (!item || item.kind !== 'approval') {
      throw new Error(`approval not found: ${id}`)
    }

    if (item.resolved && item.resolution) {
      return {
        accepted: false,
        final: item.resolution.outcome,
        by: item.resolution.by,
      }
    }

    item.resolved = true
    item.resolution = { outcome, by, ...(deviceId !== undefined ? { deviceId } : {}) }

    this.emit({
      type: 'resolved',
      id,
      outcome,
      by,
      ...(deviceId !== undefined ? { deviceId } : {}),
    })

    const listeners = this.resolveListeners.get(id)
    if (listeners) {
      this.resolveListeners.delete(id)
      for (const listener of listeners) {
        listener(item.resolution)
      }
    }

    return { accepted: true, final: outcome, by }
  }

  resolveQuestion(
    id: string,
    answers: Array<{ id: string; selected: string[]; custom?: string | undefined }>,
    by: 'phone' | 'pc' | 'system',
    deviceId?: string | undefined,
  ): { accepted: boolean; by: 'phone' | 'pc' | 'system' } {
    const item = this.items.get(id)
    if (!item || item.kind !== 'question') {
      throw new Error(`question not found: ${id}`)
    }

    if (item.resolved && item.resolution) {
      return {
        accepted: false,
        by: item.resolution.by,
      }
    }

    item.resolved = true
    item.resolution = {
      outcome: 'answered',
      by,
      answers,
      ...(deviceId !== undefined ? { deviceId } : {}),
    }

    this.emit({
      type: 'resolved',
      id,
      outcome: 'answered',
      by,
      ...(deviceId !== undefined ? { deviceId } : {}),
    })

    const listeners = this.resolveListeners.get(id)
    if (listeners) {
      this.resolveListeners.delete(id)
      for (const listener of listeners) {
        listener(item.resolution)
      }
    }

    return { accepted: true, by }
  }

  waitForResolution<T = unknown>(id: string, signal?: AbortSignal): Promise<T> {
    const item = this.items.get(id)
    if (item?.resolved && item.resolution) {
      return Promise.resolve(item.resolution as T)
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const arr = this.resolveListeners.get(id)
        if (arr) {
          const idx = arr.indexOf(listener)
          if (idx !== -1) arr.splice(idx, 1)
        }
        reject(signal?.reason ?? new Error('Aborted'))
      }

      const listener = (res: unknown) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(res as T)
      }

      if (signal?.aborted) {
        return reject(signal.reason ?? new Error('Aborted'))
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      const arr = this.resolveListeners.get(id) ?? []
      arr.push(listener)
      this.resolveListeners.set(id, arr)
    })
  }

  subscribe(listener: (event: InteractionDeltaEvent) => void): () => void {
    this.subscribers.add(listener)
    return () => {
      this.subscribers.delete(listener)
    }
  }

  private emit(event: InteractionDeltaEvent): void {
    for (const sub of this.subscribers) {
      try {
        sub(event)
      } catch {
        // subscriber error
      }
    }
  }
}
