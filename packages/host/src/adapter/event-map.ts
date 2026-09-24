/**
 * Event mapping (docs/specs/rcp-v1.md §5, blueprint §8.4):
 * Maps upstream dsh journal and stream events (SessionWireEvent) into the
 * client-facing RCP SessionEvent union, applying size bounds and truncation.
 */
import type {
  ApprovalOutcome,
  ApprovalRisk,
  ModelRef,
  Preview,
  SessionEvent,
  SessionStatus,
  ToolResultStatus,
  TurnEndStatus,
} from '@remora/protocol'

/** Maximum UTF-8 byte length for tool call arguments preview (2 KiB). */
export const MAX_TOOL_ARGS_BYTES = 2048

/** Maximum UTF-8 byte length for tool result preview before head/tail splitting (3 KiB). */
export const MAX_TOOL_OUTPUT_BYTES = 3072

/** First slice of tool output when truncated (2 KiB). */
export const TOOL_OUTPUT_HEAD_BYTES = 2048

/** Last slice of tool output when truncated (1 KiB). */
export const TOOL_OUTPUT_TAIL_BYTES = 1024

/** Maximum UTF-8 byte length for assistant text in an event (32 KiB). */
export const MAX_ASSISTANT_TEXT_BYTES = 32768

/** Raw event envelope received from dsh Session journal or stream. */
export interface DshWireEvent {
  type: string
  seq: number
  time: number
  data?: unknown
  ignorable?: boolean
}

/** Set of internal dsh events that do not produce an RCP SessionEvent. */
const IGNORABLE_DSH_EVENT_TYPES = new Set<string>([
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'request/header',
  'request/context',
  'session/title',
  'session/title-llm-request',
  'agent/inbox/spliced',
  'step/start',
  'step/end',
  'system/message',
  'user/message',
])

/** Truncates a UTF-8 string to at most `maxBytes` without cutting code points. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return decoder.decode(bytes.subarray(0, maxBytes))
}

/** Slices a UTF-8 string into first `headBytes` + '…' + last `tailBytes`. */
export function truncateUtf8HeadTail(text: string, headBytes: number, tailBytes: number): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= headBytes + tailBytes) return text
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const head = decoder.decode(bytes.subarray(0, headBytes))
  const tail = decoder.decode(bytes.subarray(bytes.length - tailBytes))
  return `${head}…${tail}`
}

/** Builds an args preview capped at 2 KiB. */
export function createArgsPreview(raw: unknown, maxBytes = MAX_TOOL_ARGS_BYTES): Preview {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) {
    return { text, bytes: bytes.length, truncated: false }
  }
  return {
    text: truncateUtf8(text, maxBytes),
    bytes: bytes.length,
    truncated: true,
  }
}

/** Builds an output preview (first 2 KiB + '…' + last 1 KiB if > 3 KiB). */
export function createOutputPreview(
  raw: unknown,
  headBytes = TOOL_OUTPUT_HEAD_BYTES,
  tailBytes = TOOL_OUTPUT_TAIL_BYTES,
): Preview {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= headBytes + tailBytes) {
    return { text, bytes: bytes.length, truncated: false }
  }
  return {
    text: truncateUtf8HeadTail(text, headBytes, tailBytes),
    bytes: bytes.length,
    truncated: true,
  }
}

/** Extracts text content from dsh message content blocks. */
function extractTextContent(content: unknown): { text: string; reasoning?: string } {
  if (typeof content === 'string') return { text: content }
  if (!Array.isArray(content)) return { text: '' }

  const textParts: string[] = []
  const reasoningParts: string[] = []

  for (const block of content) {
    if (typeof block === 'object' && block !== null) {
      const b = block as Record<string, unknown>
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        textParts.push(b['text'])
      } else if (b['type'] === 'reasoning' && typeof b['text'] === 'string') {
        reasoningParts.push(b['text'])
      }
    }
  }

  const text = textParts.join('')
  const reasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined
  return { text, ...(reasoning !== undefined ? { reasoning } : {}) }
}

/** Maps a dsh turn end reason to RCP TurnEndStatus. */
function mapTurnEndStatus(reason: unknown): TurnEndStatus {
  if (typeof reason === 'string') {
    if (reason === 'completed' || reason === 'cancelled' || reason === 'error' || reason === 'interrupted') {
      return reason
    }
  }
  if (typeof reason === 'object' && reason !== null) {
    const kind = (reason as { kind?: unknown }).kind
    if (kind === 'completed' || kind === 'cancelled' || kind === 'error' || kind === 'interrupted') {
      return kind
    }
  }
  return 'unknown'
}

/** Maps a tool status to RCP ToolResultStatus. */
function mapToolResultStatus(status: unknown): ToolResultStatus {
  if (typeof status === 'string') {
    if (
      status === 'ok' ||
      status === 'error' ||
      status === 'denied' ||
      status === 'cancelled' ||
      status === 'timeout'
    ) {
      return status
    }
  }
  return 'ok'
}

/** Maps an approval outcome to RCP ApprovalOutcome. */
function mapApprovalOutcome(outcome: unknown): ApprovalOutcome {
  if (typeof outcome === 'string') {
    if (
      outcome === 'allowed-once' ||
      outcome === 'rejected' ||
      outcome === 'cancelled' ||
      outcome === 'unavailable'
    ) {
      return outcome
    }
  }
  return 'unknown'
}

/** Maps session status string to SessionStatus. */
function mapSessionStatus(status: unknown): SessionStatus {
  if (status === 'idle' || status === 'running' || status === 'error') {
    return status
  }
  return 'unknown'
}

/**
 * Maps one dsh wire event to an RCP SessionEvent.
 * Returns `null` if the event is an internal/ignorable dsh event.
 */
export function mapDshEventToRcp(event: DshWireEvent): SessionEvent | null {
  const { type, seq, time, data } = event
  const d = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>

  switch (type) {
    case 'turn/start': {
      return { kind: 'turn.start', seq, at: time }
    }

    case 'turn/end': {
      const status = mapTurnEndStatus(d['reason'] ?? d['status'])
      const err = typeof d['error'] === 'string' ? d['error'] : undefined
      return {
        kind: 'turn.end',
        seq,
        at: time,
        status,
        ...(err !== undefined ? { error: err } : {}),
      }
    }

    case 'assistant/message': {
      const msg = (typeof d['message'] === 'object' && d['message'] !== null ? d['message'] : {}) as Record<string, unknown>
      const { text, reasoning } = extractTextContent(msg['content'])
      const truncatedText = truncateUtf8(text, MAX_ASSISTANT_TEXT_BYTES)

      let model: ModelRef | undefined
      const source = msg['source'] as Record<string, unknown> | undefined
      if (typeof source === 'object' && source !== null && typeof source['provider'] === 'string' && typeof source['model'] === 'string') {
        model = {
          provider: source['provider'],
          model: source['model'],
          ...(typeof source['reasoningEffort'] === 'string' ? { reasoningEffort: source['reasoningEffort'] } : {}),
        }
      }

      return {
        kind: 'assistant.message',
        seq,
        at: time,
        text: truncatedText,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(model !== undefined ? { model } : {}),
      }
    }

    case 'tool/call': {
      const callId = typeof d['callId'] === 'string' ? d['callId'] : `call_${seq}`
      const tool = typeof d['tool'] === 'string' ? d['tool'] : typeof d['toolName'] === 'string' ? d['toolName'] : 'unknown'
      const title = typeof d['title'] === 'string' ? d['title'] : tool
      const args = createArgsPreview(d['args'])
      return {
        kind: 'tool.call',
        seq,
        at: time,
        callId,
        tool,
        title,
        args,
      }
    }

    case 'tool/result': {
      const callId = typeof d['callId'] === 'string' ? d['callId'] : `call_${seq}`
      const status = mapToolResultStatus(d['status'])
      const output = createOutputPreview(d['output'])
      return {
        kind: 'tool.result',
        seq,
        at: time,
        callId,
        status,
        output,
      }
    }

    case 'approval/asked':
    case 'approval/request': {
      const id = typeof d['id'] === 'string' ? d['id'] : `approval_${seq}`
      const toolName = typeof d['toolName'] === 'string' ? d['toolName'] : 'unknown'
      const callId = typeof d['callId'] === 'string' ? d['callId'] : undefined
      const risk: ApprovalRisk = d['risk'] === 'high' ? 'high' : 'normal'
      return {
        kind: 'approval.asked',
        seq,
        at: time,
        id,
        toolName,
        ...(callId !== undefined ? { callId } : {}),
        risk,
      }
    }

    case 'approval/decided': {
      const toolName = typeof d['toolName'] === 'string' ? d['toolName'] : 'unknown'
      const callId = typeof d['callId'] === 'string' ? d['callId'] : undefined
      const outcome = mapApprovalOutcome(d['outcome'])
      return {
        kind: 'approval.decided',
        seq,
        at: time,
        toolName,
        ...(callId !== undefined ? { callId } : {}),
        outcome,
      }
    }

    case 'user-questions/request':
    case 'question/asked': {
      const id = typeof d['id'] === 'string' ? d['id'] : `question_${seq}`
      let text = typeof d['text'] === 'string' ? d['text'] : ''
      if (!text && Array.isArray(d['questions'])) {
        text = d['questions'].map((q: unknown) => (q as { question?: string })?.question ?? '').join('\n')
      }
      return {
        kind: 'question.asked',
        seq,
        at: time,
        id,
        text,
      }
    }

    case 'user-questions/answer':
    case 'question/decided': {
      const id = typeof d['id'] === 'string' ? d['id'] : `question_${seq}`
      const outcome = typeof d['outcome'] === 'string' ? d['outcome'] : 'answered'
      const by = d['by'] === 'phone' || d['by'] === 'pc' || d['by'] === 'system' ? d['by'] : undefined
      return {
        kind: 'question.decided',
        seq,
        at: time,
        id,
        outcome,
        ...(by !== undefined ? { by } : {}),
      }
    }

    case 'agent/error': {
      const message = typeof d['message'] === 'string' ? d['message'] : 'unknown error'
      const code = typeof d['code'] === 'string' ? d['code'] : undefined
      return {
        kind: 'agent.error',
        seq,
        at: time,
        message,
        ...(code !== undefined ? { code } : {}),
      }
    }

    case 'session/created': {
      const sessionId = typeof d['sessionId'] === 'string' ? d['sessionId'] : ''
      return {
        kind: 'session.created',
        seq,
        at: time,
        sessionId,
      }
    }

    case 'session/status': {
      const sessionId = typeof d['sessionId'] === 'string' ? d['sessionId'] : ''
      const status = mapSessionStatus(d['status'])
      return {
        kind: 'session.status',
        seq,
        at: time,
        sessionId,
        status,
      }
    }

    default: {
      if (IGNORABLE_DSH_EVENT_TYPES.has(type) || event.ignorable === true) {
        return null
      }
      // Any unrecognized dsh event decodes to the unknown fallback carrying the dshType
      return {
        kind: 'unknown',
        dshType: type,
        seq,
        at: time,
      }
    }
  }
}
