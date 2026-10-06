/**
 * Loaders for the P7-H10 real-dsh fixtures
 * (`test/fixtures/dsh-0.1.5-rc.3/`) and the narrowing needed to replay them
 * with the real upstream event types.
 *
 * The fixtures were recorded from a real `@deepseek-ai/dsh@0.1.5-rc.3` web
 * profile driven by the scripted mock LLM (`@deepseek-ai/dsh-llm-mock-server`
 * via `DEEPSEEK_BASE_URL`); the recording procedure is documented in
 * `docs/upstream/dsh-integration.md` §9. Everything here reads the recorded
 * bytes; nothing synthesizes event shapes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'

/** Directory holding the recorded real-dsh fixtures for the pinned version. */
export const FIXTURE_DIR = join(import.meta.dirname, '..', 'fixtures', 'dsh-0.1.5-rc.3')

/**
 * One durable session event envelope as recorded from `session/follow` (the
 * upstream `SessionWireEvent` shape: `type`, `seq`, `time`, `data`).
 */
export interface RecordedSessionEvent {
  type: string
  seq: number
  time: number
  data?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecordedSessionEvent(value: unknown): value is RecordedSessionEvent {
  return (
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    typeof value['seq'] === 'number' &&
    typeof value['time'] === 'number'
  )
}

/** All durable `{"type":"event"}` frames of one recorded follow JSONL fixture. */
export function loadFollowEvents(fixtureName: string): RecordedSessionEvent[] {
  const text = readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8')
  const events: RecordedSessionEvent[] = []
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const frame = JSON.parse(line) as unknown
    if (!isRecord(frame) || frame['type'] !== 'event') continue
    const event = frame['event']
    if (isRecordedSessionEvent(event)) events.push(event)
  }
  return events
}

/** The recorded raw `ApprovalRequestEvent`, agent identity reduced to `{ id }`. */
export interface RecordedApprovalRequest {
  toolName: string
  callId?: string
  reason?: string
  hasSignal: boolean
  agent: { id: string }
  sessionId: string | null
}

export function loadApprovalRequest(fixtureName = 'approval-request.json'): {
  scenario: string
  request: RecordedApprovalRequest
  outcomeReturned: string
} {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8')) as unknown
  if (!isRecord(raw) || typeof raw['scenario'] !== 'string' || !isRecord(raw['request'])) {
    throw new Error(`malformed approval fixture: ${fixtureName}`)
  }
  const req = raw['request']
  const callId = req['callId']
  const reason = req['reason']
  const sessionId = req['sessionId']
  const agent = req['agent']
  if (
    typeof req['toolName'] !== 'string' ||
    !isRecord(agent) ||
    typeof agent['id'] !== 'string'
  ) {
    throw new Error(`malformed approval request payload: ${fixtureName}`)
  }
  return {
    scenario: raw['scenario'],
    request: {
      toolName: req['toolName'],
      ...(typeof callId === 'string' ? { callId } : {}),
      ...(typeof reason === 'string' ? { reason } : {}),
      hasSignal: req['hasSignal'] === true,
      agent: { id: agent['id'] },
      ...(typeof sessionId === 'string' ? { sessionId } : { sessionId: null }),
    },
    ...(typeof raw['outcomeReturned'] === 'string'
      ? { outcomeReturned: raw['outcomeReturned'] }
      : { outcomeReturned: '' }),
  }
}

/** The recorded raw `AskUserQuestionRequestEvent`, agent identity reduced to `{ id }`. */
export function loadQuestionRequest(fixtureName = 'question-request.json'): {
  scenario: string
  request: { questions: AskUserQuestionItem[]; hasSignal: boolean; agent: { id: string }; sessionId: string | null }
} {
  const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8')) as unknown
  if (!isRecord(raw) || typeof raw['scenario'] !== 'string' || !isRecord(raw['request'])) {
    throw new Error(`malformed question fixture: ${fixtureName}`)
  }
  const req = raw['request']
  const sessionId = req['sessionId']
  const agent = req['agent']
  if (!isRecord(agent) || typeof agent['id'] !== 'string' || !Array.isArray(req['questions'])) {
    throw new Error(`malformed question request payload: ${fixtureName}`)
  }
  return {
    scenario: raw['scenario'],
    request: {
      questions: req['questions'].map((item: unknown): AskUserQuestionItem => {
        if (!isRecord(item) || typeof item['id'] !== 'string' || typeof item['question'] !== 'string') {
          throw new Error(`malformed question item: ${fixtureName}`)
        }
        const header = item['header']
        const multiSelect = item['multiSelect']
        const options = item['options']
        return {
          id: item['id'],
          question: item['question'],
          ...(typeof header === 'string' ? { header } : {}),
          ...(Array.isArray(options)
            ? {
                options: options.map((option: unknown) => {
                  if (!isRecord(option) || typeof option['label'] !== 'string') {
                    throw new Error(`malformed question option: ${fixtureName}`)
                  }
                  const description = option['description']
                  return {
                    label: option['label'],
                    ...(typeof description === 'string' ? { description } : {}),
                  }
                }),
              }
            : {}),
          ...(typeof multiSelect === 'boolean' ? { multiSelect } : {}),
        }
      }),
      hasSignal: req['hasSignal'] === true,
      agent: { id: agent['id'] },
      ...(typeof sessionId === 'string' ? { sessionId } : { sessionId: null }),
    },
  }
}

/**
 * Rebuilds the replay agent for a recorded request from recorded events.
 *
 * The runtime `Agent` face dsh augments onto the wire `Agent` at dispatch time
 * (`session.snapshotEvents()` — verified by P0-S2 Q7) carries many live
 * services; a replay from recorded bytes can only populate what the
 * AnswerBridge reads (`id`, `session.id`, `session.snapshotEvents()`), so the
 * reconstruction is one localized boundary cast. The unit under test — the
 * bridge — is real and unmocked.
 */
export function createReplayAgent(agentId: string, sessionId: string, events: readonly RecordedSessionEvent[]): Agent {
  return {
    id: SessionId(agentId),
    session: {
      id: SessionId(sessionId),
      snapshotEvents: () => events,
    },
  } as unknown as Agent
}
