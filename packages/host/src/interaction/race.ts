import { randomUUID } from 'node:crypto'
import { computeArgsDigest } from '@remora/crypto'
import type { PendingRegistry } from './pending.ts'
import type { PolicyGuard } from '../policy/index.ts'

export interface RaceApprovalOptions {
  approvalTimeoutMs?: number | undefined
  policyGuard?: PolicyGuard | undefined
  findPreview?: (agent: unknown, callId: string) => { text: string; json: string } | undefined
  hasPairedDevices?: () => boolean
}

export interface DshApprovalRequest {
  toolName: string
  callId?: string | undefined
  reason?: string | undefined
  arguments?: unknown
  params?: unknown
  agent?: {
    id?: string | undefined
    session?: { id: string; title?: string | null; snapshotEvents?: () => ReadonlyArray<{ type: string; data?: unknown }> }
  } | undefined
  signal?: AbortSignal | undefined
}

export interface DshQuestionRequest {
  questions?: Array<{
    id: string
    question: string
    detail?: string | undefined
    header?: string | undefined
    options?: Array<{ label: string; description?: string | undefined }> | undefined
    multiSelect?: boolean | undefined
    intent?: { kind: 'plan-review'; approve: string } | undefined
  }> | undefined
  agent?: {
    id?: string | undefined
    session?: { id: string; title?: string | null }
  } | undefined
  signal?: AbortSignal | undefined
}

/**
 * One structured answer of the `user-questions/request` PC chain, mirroring
 * the upstream `AskUserQuestionAnswerItem` shape structurally (this module
 * stays free of `@deepseek-ai/*` imports).
 */
export interface DshQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

/** Structural answer of the `user-questions/request` PC chain (upstream `AskUserQuestionAnswer`). */
export interface DshQuestionAnswer {
  answers: DshQuestionAnswerItem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fails closed: anything that is not an `{ id, selected[] }` item is dropped. */
function isQuestionAnswerItem(value: unknown): value is DshQuestionAnswerItem {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    Array.isArray(value['selected']) &&
    value['selected'].every((entry) => typeof entry === 'string')
  )
}

/** Structured answers of a PC-chain question result; `[]` when it is not one. */
function readQuestionAnswerItems(value: unknown): DshQuestionAnswerItem[] {
  if (!isRecord(value) || !Array.isArray(value['answers'])) return []
  return value['answers'].filter(isQuestionAnswerItem)
}

/**
 * Whether `value` is a structured question answer. The real dsh chain
 * resolves only with `AskUserQuestionAnswer` (or rejects); this guard keeps
 * anything else from reaching dsh as a fabricated user answer.
 */
export function isDshQuestionAnswer(value: unknown): value is DshQuestionAnswer {
  return isRecord(value) && Array.isArray(value['answers']) && value['answers'].every(isQuestionAnswerItem)
}

/**
 * Extracts a human-readable preview and JSON payload from an approval request.
 */
function extractPreview(
  req: DshApprovalRequest,
  findPreview?: (agent: unknown, callId: string) => { text: string; json: string } | undefined,
): { text: string; json: string } {
  if (req.callId && findPreview && req.agent) {
    const live = findPreview(req.agent, req.callId)
    if (live) return live
  }

  // Fallback to direct request arguments or toolName
  const rawArgs = req.arguments ?? req.params
  let text = req.toolName
  let json = '{}'

  if (rawArgs !== undefined && rawArgs !== null) {
    if (typeof rawArgs === 'string') {
      text = rawArgs
      json = JSON.stringify({ raw: rawArgs })
    } else if (typeof rawArgs === 'object') {
      const obj = rawArgs as Record<string, unknown>
      text = String(obj['command'] ?? obj['text'] ?? obj['prompt'] ?? req.toolName)
      try {
        json = JSON.stringify(obj)
      } catch {
        json = '{}'
      }
    }
  }

  return { text, json }
}

export async function raceApproval(
  req: DshApprovalRequest,
  next: () => Promise<string>,
  pendingRegistry: PendingRegistry,
  options: RaceApprovalOptions = {},
): Promise<string> {
  const timeoutMs = options.approvalTimeoutMs ?? 3600_000
  const id = randomUUID()
  const preview = extractPreview(req, options.findPreview)
  const argsDigest = computeArgsDigest(preview)

  const riskEval = options.policyGuard
    ? options.policyGuard.classifyRisk(req.toolName, req.arguments ?? req.params)
    : 'normal'
  const risk = riskEval
  const requiresSignature = options.policyGuard
    ? (options.policyGuard.approvalBiometric === 'all' || (options.policyGuard.approvalBiometric === 'high' && risk === 'high'))
    : false

  const now = Date.now()
  pendingRegistry.add({
    kind: 'approval',
    id,
    sessionId: req.agent?.session?.id ?? 'unknown',
    sessionTitle: req.agent?.session?.title ?? null,
    toolName: req.toolName,
    callId: req.callId,
    reason: req.reason,
    preview,
    argsDigest,
    risk,
    requiresSignature,
    createdAt: now,
    expiresAt: now + timeoutMs,
  })

  // Withdraw controller for the PC chain
  const withdrawController = new AbortController()
  const originalSignal = req.signal
  if (originalSignal) {
    const combined = AbortSignal.any([originalSignal, withdrawController.signal])
    try {
      Object.defineProperty(req, 'signal', {
        value: combined,
        configurable: true,
        writable: true,
        enumerable: true,
      })
    } catch {
      // ignore if non-configurable
    }
  }

  // 1. Fire next() into PC chain
  const pcChain = next().then(
    (outcome) => ({ side: 'pc' as const, outcome }),
    (error: unknown) => ({ side: 'pc_error' as const, error }),
  )

  // 2. Phone answer waiter
  const phoneAnswer = pendingRegistry.waitForResolution<{
    outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
    by: 'phone' | 'pc' | 'system'
  }>(id)

  let timeoutTimer: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<{ side: 'timeout' }>((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ side: 'timeout' }), timeoutMs)
  })

  const signalPromise = new Promise<{ side: 'signal' }>((resolve) => {
    if (originalSignal?.aborted) return resolve({ side: 'signal' })
    originalSignal?.addEventListener('abort', () => resolve({ side: 'signal' }), { once: true })
  })

  try {
    while (true) {
      const winner = await Promise.race([
        phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
        pcChain,
        signalPromise,
        timeoutPromise,
      ])

      if (winner.side === 'phone') {
        // Phone answered first -> withdraw PC chain
        withdrawController.abort(new Error('remora: bridge answered first; withdrawing PC chain'))
        return winner.res.outcome
      }

      if (winner.side === 'pc') {
        // If PC answered unavailable or NO_PROVIDER while devices are paired, ignore and keep waiting for phone
        const hasDevices = options.hasPairedDevices ? options.hasPairedDevices() : true
        if ((winner.outcome === 'unavailable' || winner.outcome === 'NO_PROVIDER') && hasDevices) {
          // Wait for phone or timeout
          const nextWinner = await Promise.race([
            phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
            signalPromise,
            timeoutPromise,
          ])
          if (nextWinner.side === 'phone') {
            return nextWinner.res.outcome
          }
          if (nextWinner.side === 'signal') {
            pendingRegistry.resolveApproval(id, 'cancelled', 'system')
            return 'cancelled'
          }
          pendingRegistry.resolveApproval(id, 'unavailable', 'system')
          return 'unavailable'
        }

        // PC GUI answered with a valid outcome
        const outcome = winner.outcome as 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
        pendingRegistry.resolveApproval(id, outcome, 'pc')
        return outcome
      }

      if (winner.side === 'pc_error') {
        // If error was withdrawal from bridge, phone already won or is handling
        const hasDevices = options.hasPairedDevices ? options.hasPairedDevices() : true
        if (hasDevices) {
          const nextWinner = await Promise.race([
            phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
            signalPromise,
            timeoutPromise,
          ])
          if (nextWinner.side === 'phone') {
            return nextWinner.res.outcome
          }
        }
        pendingRegistry.resolveApproval(id, 'unavailable', 'system')
        return 'unavailable'
      }

      if (winner.side === 'signal') {
        withdrawController.abort()
        pendingRegistry.resolveApproval(id, 'cancelled', 'system')
        return 'cancelled'
      }

      if (winner.side === 'timeout') {
        withdrawController.abort()
        pendingRegistry.resolveApproval(id, 'unavailable', 'system')
        return 'unavailable'
      }
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}

export async function raceQuestion(
  req: DshQuestionRequest,
  next: () => Promise<unknown>,
  pendingRegistry: PendingRegistry,
  options: {
    questionTimeoutMs?: number | undefined
    hasPairedDevices?: () => boolean
  } = {},
): Promise<unknown> {
  const timeoutMs = options.questionTimeoutMs ?? 3600_000
  const id = randomUUID()
  const now = Date.now()

  pendingRegistry.add({
    kind: 'question',
    id,
    sessionId: req.agent?.session?.id ?? 'unknown',
    sessionTitle: req.agent?.session?.title ?? null,
    questions: req.questions ?? [],
    createdAt: now,
    expiresAt: now + timeoutMs,
  })

  const withdrawController = new AbortController()
  const originalSignal = req.signal
  if (originalSignal) {
    const combined = AbortSignal.any([originalSignal, withdrawController.signal])
    try {
      Object.defineProperty(req, 'signal', {
        value: combined,
        configurable: true,
        writable: true,
        enumerable: true,
      })
    } catch {
      // ignore
    }
  }

  const pcChain = next().then(
    (value) => ({ side: 'pc' as const, value }),
    (error: unknown) => ({ side: 'pc_error' as const, error }),
  )

  const phoneAnswer = pendingRegistry.waitForResolution<{
    outcome: string
    by: 'phone' | 'pc' | 'system'
    answers?: DshQuestionAnswerItem[] | undefined
  }>(id)

  let timeoutTimer: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<{ side: 'timeout' }>((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ side: 'timeout' }), timeoutMs)
  })

  const signalPromise = new Promise<{ side: 'signal' }>((resolve) => {
    if (originalSignal?.aborted) return resolve({ side: 'signal' })
    originalSignal?.addEventListener('abort', () => resolve({ side: 'signal' }), { once: true })
  })

  try {
    while (true) {
      const winner = await Promise.race([
        phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
        pcChain,
        signalPromise,
        timeoutPromise,
      ])

      if (winner.side === 'phone') {
        withdrawController.abort(new Error('remora: bridge answered first; withdrawing PC chain'))
        return { answers: winner.res.answers ?? [] }
      }

      if (winner.side === 'pc') {
        const hasDevices = options.hasPairedDevices ? options.hasPairedDevices() : true
        if (winner.value === 'unavailable' && hasDevices) {
          const nextWinner = await Promise.race([
            phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
            signalPromise,
            timeoutPromise,
          ])
          if (nextWinner.side === 'phone') {
            return { answers: nextWinner.res.answers ?? [] }
          }
          return winner.value
        }

        const answers = readQuestionAnswerItems(winner.value)
        pendingRegistry.resolveQuestion(id, answers, 'pc')
        return winner.value
      }

      if (winner.side === 'pc_error') {
        const hasDevices = options.hasPairedDevices ? options.hasPairedDevices() : true
        if (hasDevices) {
          const nextWinner = await Promise.race([
            phoneAnswer.then((res) => ({ side: 'phone' as const, res })),
            signalPromise,
            timeoutPromise,
          ])
          if (nextWinner.side === 'phone') {
            return { answers: nextWinner.res.answers ?? [] }
          }
        }
        throw winner.error
      }

      if (winner.side === 'signal') {
        withdrawController.abort()
        pendingRegistry.resolveQuestion(id, [], 'system')
        return { answers: [] }
      }

      if (winner.side === 'timeout') {
        withdrawController.abort()
        pendingRegistry.resolveQuestion(id, [], 'system')
        return { answers: [] }
      }
    }
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
  }
}
