/**
 * dsh journal → RCP event mapping (RCP/1 §5, blueprint §8.4).
 *
 * `mapDshEventToRcp` translates one dsh `SessionWireEvent` envelope — from a
 * `session/follow` frame, a `session/page` record, or a host-synthesized
 * event of the same shape — into one RCP `SessionEvent`:
 *
 * - **Truncation (RCP/1 §5):** `tool.call.args` ≤ 2 KiB; `tool.result.output`
 *   = first 2 KiB + `…` + last 1 KiB once the payload exceeds 3 KiB; one
 *   `assistant.message` event carries at most 32 KiB of model output (text
 *   first, reasoning with the remainder) so a live `events` item stays inside
 *   the 48 KiB RCP message budget. `Preview.bytes` is the UTF-8 size of the
 *   complete payload, so the peer can report "showing x of y" and page the
 *   rest with `sessions.eventText` / `sessions.toolOutput`.
 * - **Unknown types** become `{ kind: 'unknown', dshType: event.type }` with
 *   `seq`/`at` preserved, so ordering and resume cursors never break
 *   (blueprint §8.5: durable events are forwarded, never dropped).
 * - **`null`** means "no session event at all": envelopes dsh marked
 *   `ignorable` plus the internal bookkeeping types in
 *   `INTERNAL_DSH_EVENT_TYPES`, which carry no phone-visible session content.
 * - **Fail closed:** an event that cannot be represented faithfully (malformed
 *   envelope, an id that is not the UUIDv4 RCP requires, a missing required
 *   field) falls back to `unknown`, and every emitted event must satisfy
 *   `SessionEventSchema`, so a peer never receives an event its decoder would
 *   reject.
 *
 * Upstream shapes read here are verified against `@deepseek-ai/dsh@0.1.5-rc.3`
 * (`packages/core/session/src/types.ts`, `packages/interaction/user-approval/src/types.ts`)
 * and recorded fixtures in `test/fixtures/dsh-0.1.5-rc.3/`.
 */
import {
  SessionEventSchema,
  UuidSchema,
  type ApprovalOutcome,
  type ModelRef,
  type Preview,
  type SessionEvent,
  type SessionStatus,
  type ToolResultStatus,
  type TurnEndStatus,
} from '@remora/protocol'

/** Largest tool-call argument preview, UTF-8 bytes (2 KiB, RCP/1 §5). */
export const MAX_TOOL_ARGS_BYTES = 2_048

/** Largest tool-output payload carried whole, UTF-8 bytes (3 KiB, RCP/1 §5). */
export const MAX_TOOL_OUTPUT_BYTES = 3_072

/** Head slice of a truncated tool output, UTF-8 bytes (2 KiB, RCP/1 §5). */
export const TOOL_OUTPUT_HEAD_BYTES = 2_048

/** Tail slice of a truncated tool output, UTF-8 bytes (1 KiB, RCP/1 §5). */
export const TOOL_OUTPUT_TAIL_BYTES = 1_024

/** Model-output budget of one `assistant.message` event, UTF-8 bytes (32 KiB, RCP/1 §5). */
export const MAX_ASSISTANT_TEXT_BYTES = 32_768

/**
 * One raw dsh journal envelope as it arrives from `session/follow`,
 * `session/page`, or a host-synthesized event of the same shape; mirrors the
 * upstream `SessionWireEvent` (`packages/api/session-controller/src/types.ts`).
 */
export interface DshWireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
  /** Upstream's "a reader that does not know this type may skip it" marker. */
  readonly ignorable?: boolean
}

/**
 * dsh journal types with no phone-visible session content: policy and sandbox
 * snapshots, request bookkeeping, inbox/step bookkeeping, title derivation,
 * the rendered system prompt, and the seed marker. User messages are *not*
 * here — conversation content is forwarded even while RCP/1's `user.message`
 * kind awaits a contract change (AGENTS.md §6).
 */
const INTERNAL_DSH_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent/inbox/spliced',
  'approval/policy',
  'permission/preset',
  'request/context',
  'request/header',
  'sandbox/mode',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'system/message',
])

/** dsh `TurnEndReason.kind` → RCP status; unlisted merge-extensible kinds fall back to `unknown`. */
const TURN_END_STATUS: Readonly<Record<string, TurnEndStatus>> = {
  completed: 'completed',
  aborted: 'cancelled',
  interrupted: 'interrupted',
  error: 'error',
  cancelled: 'cancelled',
  unknown: 'unknown',
}

const TOOL_RESULT_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'error',
  'denied',
  'cancelled',
  'timeout',
  'unknown',
])

const APPROVAL_OUTCOMES: ReadonlySet<string> = new Set([
  'allowed-once',
  'rejected',
  'cancelled',
  'unavailable',
  'unknown',
])

const SESSION_STATUSES: ReadonlySet<string> = new Set(['idle', 'running', 'error'])

const ANSWERED_BY: ReadonlySet<string> = new Set(['phone', 'pc', 'system'])

const ENCODER = new TextEncoder()
/** `ignoreBOM` keeps a leading U+FEFF intact: decoded slices must round-trip their bytes. */
const DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })

/** Shared fields of every mapped event plus the dsh type that produced it. */
interface EventEnvelope {
  type: string
  seq: number
  at: number
}

/** Truncates `text` to at most `maxBytes` of UTF-8, never splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = ENCODER.encode(text)
  if (bytes.length <= maxBytes) return text
  return DECODER.decode(bytes.subarray(0, codePointFloor(bytes, maxBytes)))
}

/** Renders `text` as first `headBytes` + `…` + last `tailBytes`, on code-point boundaries. */
export function truncateUtf8HeadTail(text: string, headBytes: number, tailBytes: number): string {
  const bytes = ENCODER.encode(text)
  if (bytes.length <= headBytes + tailBytes) return text
  const head = DECODER.decode(bytes.subarray(0, codePointFloor(bytes, headBytes)))
  const tailStart = codePointCeil(bytes, Math.max(0, bytes.length - tailBytes))
  const tail = DECODER.decode(bytes.subarray(tailStart))
  return `${head}…${tail}`
}

/** Builds a `tool.call` argument preview bounded by `maxBytes` (default 2 KiB). */
export function createArgsPreview(raw: unknown, maxBytes = MAX_TOOL_ARGS_BYTES): Preview {
  return headPreview(toPreviewText(raw), maxBytes)
}

/** Builds a `tool.result` output preview: whole up to 3 KiB, else head 2 KiB + `…` + tail 1 KiB. */
export function createOutputPreview(
  raw: unknown,
  headBytes = TOOL_OUTPUT_HEAD_BYTES,
  tailBytes = TOOL_OUTPUT_TAIL_BYTES,
): Preview {
  const text = toPreviewText(raw)
  const bytes = ENCODER.encode(text).length
  if (bytes <= headBytes + tailBytes) return { text, bytes, truncated: false }
  return { text: truncateUtf8HeadTail(text, headBytes, tailBytes), bytes, truncated: true }
}

/**
 * Maps one dsh wire event to an RCP `SessionEvent`.
 * Returns `null` for a malformed envelope, an `ignorable` envelope, or an
 * internal dsh type that has no session-event counterpart.
 */
export function mapDshEventToRcp(event: DshWireEvent): SessionEvent | null {
  const envelope = readEnvelope(event)
  if (envelope === null) return null
  if (event.ignorable === true) return null
  if (INTERNAL_DSH_EVENT_TYPES.has(envelope.type)) return null

  const mapped = mapKnownEvent(envelope, event.data)
  const candidate = mapped ?? unknownEvent(envelope)
  return SessionEventSchema.safeParse(candidate).success ? candidate : unknownEvent(envelope)
}

function mapKnownEvent(envelope: EventEnvelope, raw: unknown): SessionEvent | null {
  const { type, seq, at } = envelope
  const data = isRecord(raw) ? raw : {}

  switch (type) {
    case 'turn/start':
      return { kind: 'turn.start', seq, at }

    case 'turn/end': {
      const reason = data['reason'] ?? data['status']
      const status = TURN_END_STATUS[reasonKey(reason)] ?? 'unknown'
      const error = readTurnEndError(reason, data['error'])
      return { kind: 'turn.end', seq, at, status, ...(error !== undefined ? { error } : {}) }
    }

    case 'assistant/message': {
      const message = isRecord(data['message']) ? data['message'] : undefined
      const content = message === undefined ? undefined : message['content']
      const text = truncateUtf8(blocksOfType(content, 'text'), MAX_ASSISTANT_TEXT_BYTES)
      const reasoningBudget = MAX_ASSISTANT_TEXT_BYTES - ENCODER.encode(text).length
      const reasoning = truncateUtf8(blocksOfType(content, 'reasoning'), reasoningBudget)
      const model = readModelRef(message === undefined ? undefined : message['source'])
      return {
        kind: 'assistant.message',
        seq,
        at,
        text,
        ...(reasoning !== '' ? { reasoning } : {}),
        ...(model !== undefined ? { model } : {}),
      }
    }

    case 'tool/call': {
      const tool = firstString(data['name'], data['tool'], data['toolName'])
      const callId = firstString(data['callId'])
      if (tool === undefined || callId === undefined) return null
      const title = firstString(data['title']) ?? tool
      // dsh logs the raw JSON string the model produced as `arguments`.
      const args = createArgsPreview(data['arguments'] ?? data['args'])
      return { kind: 'tool.call', seq, at, callId, tool, title, args }
    }

    case 'tool/result': {
      const message = isRecord(data['message']) ? data['message'] : undefined
      const block = findToolResultBlock(message)
      const source = message !== undefined && isRecord(message['source']) ? message['source'] : undefined
      const callId = firstString(data['callId'], block?.['toolCallId'], source?.['callId'])
      if (callId === undefined) return null
      const status = readToolResultStatus(data, block)
      const output = createOutputPreview(renderToolResultText(data, block))
      return { kind: 'tool.result', seq, at, callId, status, output }
    }

    case 'approval/asked': {
      const id = firstUuid(data['id'])
      const toolName = firstString(data['toolName'])
      if (id === undefined || toolName === undefined) return null
      const callId = firstString(data['callId'])
      // The journal carries no risk; an absent `risk` decodes to the
      // conservative `high`, so the mapper never claims a request is safe.
      return { kind: 'approval.asked', seq, at, id, toolName, ...(callId !== undefined ? { callId } : {}) }
    }

    case 'approval/decided': {
      // dsh's audit payload carries only `{ id, outcome }`, so a decision
      // without the `toolName` RCP requires (the raw journal record) degrades
      // to `unknown`; the AnswerBridge's durable decision carries it.
      const toolName = firstString(data['toolName'])
      if (toolName === undefined) return null
      const callId = firstString(data['callId'])
      return {
        kind: 'approval.decided',
        seq,
        at,
        toolName,
        ...(callId !== undefined ? { callId } : {}),
        outcome: readApprovalOutcome(data['outcome']),
      }
    }

    case 'question/asked': {
      const id = firstUuid(data['id'])
      const text = firstString(data['text']) ?? joinQuestionText(data['questions'])
      if (id === undefined || text === undefined) return null
      return { kind: 'question.asked', seq, at, id, text }
    }

    case 'question/decided': {
      const id = firstUuid(data['id'])
      const outcome = firstString(data['outcome'])
      if (id === undefined || outcome === undefined) return null
      const rawBy = data['by']
      const by = typeof rawBy === 'string' && ANSWERED_BY.has(rawBy) ? (rawBy as 'phone' | 'pc' | 'system') : undefined
      return { kind: 'question.decided', seq, at, id, outcome, ...(by !== undefined ? { by } : {}) }
    }

    case 'agent/error': {
      const nested = isRecord(data['error']) ? data['error'] : undefined
      const errorText = typeof data['error'] === 'string' ? data['error'] : undefined
      const message = firstString(data['message'], errorText, nested?.['message'])
      if (message === undefined) return null
      const code = firstString(data['code'], nested?.['code'])
      return { kind: 'agent.error', seq, at, message, ...(code !== undefined ? { code } : {}) }
    }

    case 'session/created': {
      const sessionId = firstString(data['sessionId'], data['id'])
      if (sessionId === undefined) return null
      return { kind: 'session.created', seq, at, sessionId }
    }

    case 'session/status': {
      const sessionId = firstString(data['sessionId'], data['id'])
      if (sessionId === undefined) return null
      const rawStatus = data['status']
      const status =
        typeof rawStatus === 'string' && SESSION_STATUSES.has(rawStatus) ? (rawStatus as SessionStatus) : 'unknown'
      return { kind: 'session.status', seq, at, sessionId, status }
    }

    default:
      return null
  }
}

function unknownEvent(envelope: EventEnvelope): SessionEvent {
  return { kind: 'unknown', dshType: envelope.type, seq: envelope.seq, at: envelope.at }
}

/** Validates `type`, `seq`, and `time`; a peer cannot sequence anything else. */
function readEnvelope(value: unknown): EventEnvelope | null {
  if (!isRecord(value)) return null
  const type = value['type']
  const seq = value['seq']
  const time = value['time']
  if (typeof type !== 'string' || type.length === 0) return null
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return null
  if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) return null
  return { type, seq, at: time }
}

/** dsh reason object key, tolerating host-synthesized envelopes carrying `status`. */
function reasonKey(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (isRecord(reason)) {
    const kind = reason['kind']
    if (typeof kind === 'string') return kind
  }
  return ''
}

/** Error text of a `turn/end`: the dsh `reason.error` facts, or a synthesized `data.error`. */
function readTurnEndError(reason: unknown, explicit: unknown): string | undefined {
  const fromReason = isRecord(reason) ? reason['error'] : undefined
  return firstString(
    typeof explicit === 'string' ? explicit : undefined,
    isRecord(explicit) ? explicit['message'] : undefined,
    isRecord(fromReason) ? fromReason['message'] : undefined,
    typeof fromReason === 'string' ? fromReason : undefined,
  )
}

/** `ModelRef` from a dsh `ModelMessageSource`; absent when the message names no model. */
function readModelRef(raw: unknown): ModelRef | undefined {
  if (!isRecord(raw)) return undefined
  const provider = firstString(raw['provider'])
  const model = firstString(raw['model'])
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = firstString(raw['reasoningEffort'])
  return { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
}

/**
 * dsh reports a tool outcome as the block's `isError` flag; the RCP
 * vocabulary's `denied`/`cancelled`/`timeout` come from host-side decisions
 * and are only read from an explicitly logged `status`.
 */
function readToolResultStatus(
  data: Record<string, unknown>,
  block: Record<string, unknown> | undefined,
): ToolResultStatus {
  const explicit = firstString(data['status'])
  if (explicit !== undefined && TOOL_RESULT_STATUSES.has(explicit)) return explicit as ToolResultStatus
  if (data['error'] !== undefined) return 'error'
  if (block !== undefined) return block['isError'] === true ? 'error' : 'ok'
  return 'unknown'
}

function readApprovalOutcome(raw: unknown): ApprovalOutcome {
  const outcome = firstString(raw)
  if (outcome !== undefined && APPROVAL_OUTCOMES.has(outcome)) return outcome as ApprovalOutcome
  return 'unknown'
}

/** The `tool-result` block of a dsh `ToolResultMessage`. */
function findToolResultBlock(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const content = message === undefined ? undefined : asArray(message['content'])
  if (content === undefined) return undefined
  for (const entry of content) {
    if (isRecord(entry) && entry['type'] === 'tool-result') return entry
  }
  return undefined
}

/** Model-facing text of a `tool/result`: its block content, or a synthesized `output`. */
function renderToolResultText(
  data: Record<string, unknown>,
  block: Record<string, unknown> | undefined,
): string {
  if (data['output'] !== undefined) return toPreviewText(data['output'])
  if (block === undefined) return ''
  return blocksOfType(block['content'], 'text')
}

/** Concatenated text of one dsh content-block type; blocks join with a newline. */
function blocksOfType(content: unknown, blockType: 'text' | 'reasoning'): string {
  if (typeof content === 'string') return blockType === 'text' ? content : ''
  const list = asArray(content)
  if (list === undefined) return ''
  const parts: string[] = []
  for (const block of list) {
    if (isRecord(block) && block['type'] === blockType && typeof block['text'] === 'string') {
      parts.push(block['text'])
    }
  }
  return parts.join('\n')
}

/** Question text from an `ask_user_question` payload when no `text` was logged. */
function joinQuestionText(raw: unknown): string | undefined {
  const list = asArray(raw)
  if (list === undefined) return undefined
  const parts: string[] = []
  for (const item of list) {
    if (isRecord(item) && typeof item['question'] === 'string') parts.push(item['question'])
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Preview source text: dsh logs arguments as a raw JSON string, results as content. */
function toPreviewText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw === undefined || raw === null) return ''
  try {
    return JSON.stringify(raw) ?? ''
  } catch {
    // Only reachable for a non-JSON value such as a cycle; a preview of nothing beats a throw.
    return ''
  }
}

function headPreview(text: string, maxBytes: number): Preview {
  const bytes = ENCODER.encode(text).length
  if (bytes <= maxBytes) return { text, bytes, truncated: false }
  return { text: truncateUtf8(text, maxBytes), bytes, truncated: true }
}

/** Last offset ≤ `limit` that ends on a code point, so a decode never yields U+FFFD. */
function codePointFloor(bytes: Uint8Array, limit: number): number {
  let end = Math.min(limit, bytes.length)
  while (end > 0) {
    const byte = bytes[end]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    end -= 1
  }
  return end
}

/** First offset ≥ `start` that begins a code point. */
function codePointCeil(bytes: Uint8Array, start: number): number {
  let index = Math.max(0, start)
  while (index < bytes.length) {
    const byte = bytes[index]
    if (byte === undefined || (byte & 0xc0) !== 0x80) break
    index += 1
  }
  return index
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** First non-empty string among `values`. */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/** First value that is the UUIDv4 RCP/1 requires for pending-item ids. */
function firstUuid(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && UuidSchema.safeParse(value).success) return value
  }
  return undefined
}
