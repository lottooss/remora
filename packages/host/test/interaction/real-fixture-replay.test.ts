/**
 * P7-H10: replay the recorded REAL dsh fixtures through the AnswerBridge.
 *
 * The fixtures under `test/fixtures/dsh-0.1.5-rc.3/` were recorded from a real
 * `@deepseek-ai/dsh@0.1.5-rc.3` web profile driven by the scripted mock LLM
 * (recording procedure: `docs/upstream/dsh-integration.md` §9). They carry
 * the real event shapes: `tool/call` data is
 * `{ turn, step, callId, name, arguments }` where `arguments` is the raw JSON
 * STRING the model produced — not a parsed object.
 *
 * The bridge is exercised through a real `@deepseek-ai/cordis` waterfall the
 * way dsh dispatches it; only the agent's live-session handle
 * (`agent.session.snapshotEvents`, verified by P0-S2 Q7) is rebuilt from the
 * recorded journal, because the recorded payload reduces the agent identity
 * to `{ id }`. The unit under test — `registerAnswerBridge` / `raceApproval` —
 * is never mocked.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome, ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionAnswer, AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types'
import { computeArgsDigest } from '@remora/crypto'
import { describe, expect, it } from 'vitest'
import {
  InMemoryDeviceRegistry,
  PendingRegistry,
  registerAnswerBridge,
} from '../../src/index.ts'
import { mapDshEventToRcp } from '../../src/adapter/event-map.ts'
import {
  createReplayAgent,
  loadApprovalRequest,
  loadFollowEvents,
  loadQuestionRequest,
  type RecordedSessionEvent,
} from './fixtures.ts'

/** The recorded bash command the mock LLM called the real `bash` tool with. */
const RECORDED_BASH_COMMAND = 'echo remora-p7-h10 && uptime'
/** The parsed-and-re-serialized recorded arguments (preview.json after the fix). */
const RECORDED_BASH_ARGS_JSON = `{"command":"${RECORDED_BASH_COMMAND}"}`

/** One paired (non-revoked) device so the bridge engages instead of delegating. */
function createPairedDevice(deviceId: string): Parameters<InMemoryDeviceRegistry['addDevice']>[0] {
  return {
    deviceId,
    name: 'Verifier Phone',
    noisePublicKey: new Uint8Array(32),
    devicePsk: new Uint8Array(32),
    pushKey: new Uint8Array(32),
    createdAt: 1_000,
    lastSeenAt: 1_000,
    revoked: false,
  }
}

/** Lets the async waterfall reach the bridge listener before assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 10) })
}

describe('P7-H10: AnswerBridge against the recorded real-dsh fixtures', () => {
  it('approval preview for the recorded bash tool/call shows the command, not the raw JSON string', async () => {
    const events = loadFollowEvents('follow-tool-approval.jsonl')
    const recorded = loadApprovalRequest()
    const toolCall = events.find((event) => event.type === 'tool/call')
    expect(toolCall).toBeDefined()
    // The recorded shape this test protects: `arguments` is a JSON string.
    expect(typeof (toolCall?.data as Record<string, unknown> | undefined)?.['arguments']).toBe('string')

    const ctx = new Context()
    const registry = new InMemoryDeviceRegistry()
    registry.addDevice(createPairedDevice('d_replay1'))
    const pendingRegistry = new PendingRegistry()
    registerAnswerBridge(ctx, { registry, pendingRegistry })

    const sessionId = recorded.request.sessionId ?? recorded.request.agent.id
    const req: ApprovalRequestEvent = {
      toolName: recorded.request.toolName,
      agent: createReplayAgent(recorded.request.agent.id, sessionId, events),
      ...(recorded.request.callId !== undefined ? { callId: ToolCallId(recorded.request.callId) } : {}),
      ...(recorded.request.reason !== undefined ? { reason: recorded.request.reason } : {}),
      // The recorded request carries a live cancellation signal.
      signal: new AbortController().signal,
    }

    // The PC chain is the parked waterfall terminal (ADR-0008: with zero
    // remote-event clients next() never settles on its own).
    const outcomePromise = ctx.waterfall(
      'approval/request',
      req,
      () => new Promise<ApprovalOutcome>(() => {}),
    )
    await settle()

    const pending = pendingRegistry.list()[0]
    expect(pending?.kind).toBe('approval')
    if (pending?.kind !== 'approval') throw new Error('no pending approval was created')

    // Crypto/1 §7: the digest is computed over the exact preview the phone
    // displays, so it must match the stored text/json byte for byte.
    const expectedDigest = computeArgsDigest({ text: RECORDED_BASH_COMMAND, json: RECORDED_BASH_ARGS_JSON })
    expect(pending.preview.text).toBe(RECORDED_BASH_COMMAND)
    expect(pending.preview.json).toBe(RECORDED_BASH_ARGS_JSON)
    expect(pending.argsDigest).toBe(expectedDigest)

    pendingRegistry.resolveApproval(pending.id, 'allowed-once', 'phone', 'd_replay1')
    expect(await outcomePromise).toBe('allowed-once')
  })

  it('maps the recorded real tool/call and tool/result to RCP tool.call / tool.result', () => {
    const events = loadFollowEvents('follow-tool-approval.jsonl')
    const toolCall = events.find((event) => event.type === 'tool/call')
    const toolResult = events.find((event) => event.type === 'tool/result')
    if (toolCall === undefined || toolResult === undefined) throw new Error('fixture lacks tool/call or tool/result')

    const mappedCall = mapDshEventToRcp(toolCall)
    expect(mappedCall).toMatchObject({
      kind: 'tool.call',
      callId: 'mock-call-1',
      tool: 'bash',
      title: 'bash',
      args: { text: RECORDED_BASH_ARGS_JSON, truncated: false },
    })
    const argsBytes = new TextEncoder().encode(RECORDED_BASH_ARGS_JSON).length
    expect(mappedCall?.kind === 'tool.call' ? mappedCall.args : undefined).toMatchObject({ bytes: argsBytes })

    const mappedResult = mapDshEventToRcp(toolResult)
    expect(mappedResult).toMatchObject({
      kind: 'tool.result',
      callId: 'mock-call-1',
      status: 'ok',
      // The tool's model-facing output, rendered by the real tool execution.
      output: { text: '{"ok":true,"command":"echo remora-p7-h10 && uptime"}', truncated: false },
    })

    // The audit events around the decision also carry the real shapes.
    const approvalAsked = events.find((event) => event.type === 'approval/asked')
    const approvalDecided = events.find((event) => event.type === 'approval/decided')
    if (approvalAsked === undefined || approvalDecided === undefined) {
      throw new Error('fixture lacks approval/asked or approval/decided')
    }
    expect(mapDshEventToRcp(approvalAsked)).toMatchObject({
      kind: 'approval.asked',
      toolName: 'bash',
      callId: 'mock-call-1',
    })
  })

  it('maps the recorded real ask_user_question tool call and its answer to RCP events', () => {
    const events = loadFollowEvents('follow-question.jsonl')
    const toolCall = events.find((event) => event.type === 'tool/call')
    const toolResult = events.find((event) => event.type === 'tool/result')
    if (toolCall === undefined || toolResult === undefined) throw new Error('fixture lacks tool/call or tool/result')

    const mappedCall = mapDshEventToRcp(toolCall)
    expect(mappedCall?.kind).toBe('tool.call')
    if (mappedCall?.kind !== 'tool.call') throw new Error('tool/call did not map')
    expect(mappedCall.tool).toBe('ask_user_question')
    // args.text stays the raw JSON string the model produced (compactly intact).
    const parsed = JSON.parse(mappedCall.args.text) as unknown
    expect(parsed).toMatchObject({ questions: [{ id: 'deploy-mode' }] })

    const mappedResult = mapDshEventToRcp(toolResult)
    expect(mappedResult).toMatchObject({ kind: 'tool.result', callId: 'mock-call-1', status: 'ok' })
  })

  it('question replay: the recorded ask_user_question request creates the pending question and the phone answer wins', async () => {
    const events = loadFollowEvents('follow-question.jsonl')
    const recorded = loadQuestionRequest()

    const ctx = new Context()
    const registry = new InMemoryDeviceRegistry()
    registry.addDevice(createPairedDevice('d_replay1'))
    const pendingRegistry = new PendingRegistry()
    registerAnswerBridge(ctx, { registry, pendingRegistry })

    const sessionId = recorded.request.sessionId ?? recorded.request.agent.id
    const req: AskUserQuestionRequestEvent = {
      questions: recorded.request.questions,
      agent: createReplayAgent(recorded.request.agent.id, sessionId, events),
      signal: new AbortController().signal,
    }

    const answerPromise = ctx.waterfall(
      'user-questions/request',
      req,
      () => new Promise<AskUserQuestionAnswer>(() => {}),
    )
    await settle()

    const pending = pendingRegistry.list()[0]
    expect(pending?.kind).toBe('question')
    if (pending?.kind !== 'question') throw new Error('no pending question was created')
    expect(pending.questions).toEqual(recorded.request.questions)

    pendingRegistry.resolveQuestion(
      pending.id,
      [{ id: 'deploy-mode', selected: ['Supervised'] }],
      'phone',
      'd_replay1',
    )
    const answer = await answerPromise
    expect(answer.answers[0]?.id).toBe('deploy-mode')
    expect(answer.answers[0]?.selected).toEqual(['Supervised'])
  })

  it('recorded events replay through the event map: phone-visible types map, internal types map to null by design', () => {
    // Phone-visible journal types observed in the real recording: every one
    // must produce a mapped RCP event (durable content is never dropped,
    // blueprint §8.5).
    const VISIBLE_TYPES: ReadonlySet<string> = new Set([
      'turn/start',
      'turn/end',
      'assistant/message',
      'user/message',
      'tool/call',
      'tool/result',
      'approval/asked',
      // Real dsh's audit decision carries only { id, outcome } (no toolName),
      // so it maps to `unknown` — forwarded, never dropped.
      'approval/decided',
    ])
    // Internal bookkeeping types (event-map.ts INTERNAL_DSH_EVENT_TYPES):
    // `null` is the designed outcome — they carry no session content.
    const INTERNAL_TYPES: ReadonlySet<string> = new Set([
      'agent/inbox/spliced',
      'approval/policy',
      'permission/preset',
      'request/context',
      'request/header',
      'sandbox/mode',
      'session/title',
      'session/title-llm-request',
      'step/end',
      'step/start',
      'system/message',
    ])
    for (const fixtureName of ['follow-tool-approval.jsonl', 'follow-question.jsonl']) {
      const events: RecordedSessionEvent[] = loadFollowEvents(fixtureName)
      expect(events.length).toBeGreaterThan(10)
      for (const event of events) {
        expect(VISIBLE_TYPES.has(event.type) || INTERNAL_TYPES.has(event.type)).toBe(true)
        const mapped = mapDshEventToRcp(event)
        if (VISIBLE_TYPES.has(event.type)) {
          // Mapped or degraded to `unknown` — never dropped.
          expect(mapped).not.toBeNull()
        } else {
          expect(mapped).toBeNull()
        }
      }
    }
  })
})
