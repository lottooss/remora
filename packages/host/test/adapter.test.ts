import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RCP_ERROR_CODES,
  SessionEventSchema,
  type SessionEvent,
} from '@remora/protocol'
import {
  DSH_ERROR_CODE_MAP,
  gatewaySessionCreate,
  gatewaySessionList,
  gatewaySessionPrompt,
  mapDshErrorToRcp,
  type TypertGateway,
} from '../src/adapter/gateway.ts'
import {
  MAX_ASSISTANT_TEXT_BYTES,
  MAX_TOOL_ARGS_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  TOOL_OUTPUT_HEAD_BYTES,
  TOOL_OUTPUT_TAIL_BYTES,
  createArgsPreview,
  createOutputPreview,
  mapDshEventToRcp,
  truncateUtf8,
  truncateUtf8HeadTail,
  type DshWireEvent,
} from '../src/adapter/event-map.ts'
import { LiveCoalescer } from '../src/adapter/live.ts'
import { SessionAdapter } from '../src/adapter/sessions.ts'
import { RcpServer, type RcpStreamSink } from '../src/rcp/index.ts'
import { registerSessionMethods } from '../src/rcp/methods/sessions.ts'

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/dsh-0.1.5-rc.3')

/** Every `event` record of a recorded follow fixture, in wire order. */
function wireEventsFromJsonl(file: string): DshWireEvent[] {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8')
  const events: DshWireEvent[] = []
  for (const line of raw.trim().split('\n')) {
    const frame = JSON.parse(line) as { type?: unknown; records?: unknown; event?: unknown }
    if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
      for (const record of frame.records) {
        const rec = record as { type?: unknown; event?: unknown }
        if (rec.type === 'event' && rec.event !== undefined) events.push(rec.event as DshWireEvent)
      }
    } else if (frame.type === 'event' && frame.event !== undefined) {
      events.push(frame.event as DshWireEvent)
    }
  }
  return events
}

/** Wire events of the recorded history page fixture. */
function wireEventsFromPage(): DshWireEvent[] {
  const page = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'page.json'), 'utf8')) as {
    records?: unknown[]
  }
  const events: DshWireEvent[] = []
  for (const record of page.records ?? []) {
    const rec = record as { type?: unknown; event?: unknown }
    if (rec.type === 'event' && rec.event !== undefined) events.push(rec.event as DshWireEvent)
  }
  return events
}

function wire(
  type: string,
  data: unknown,
  overrides: { seq?: number; time?: number; ignorable?: boolean } = {},
): DshWireEvent {
  return {
    type,
    seq: overrides.seq ?? 1,
    time: overrides.time ?? 1_700_000_000_000,
    data,
    ...(overrides.ignorable !== undefined ? { ignorable: overrides.ignorable } : {}),
  }
}

describe('Adapter: event-map', () => {
  it('maps follow fixture events and keeps every mapped event decodable', () => {
    const wireEvents = wireEventsFromJsonl('follow-opening.jsonl')
    expect(wireEvents.length).toBeGreaterThan(0)

    const mappedEvents = wireEvents
      .map((event) => mapDshEventToRcp(event))
      .filter((event): event is SessionEvent => event !== null)

    expect(mappedEvents.some((e) => e.kind === 'turn.start')).toBe(true)
    expect(mappedEvents.some((e) => e.kind === 'assistant.message')).toBe(true)
    expect(mappedEvents.some((e) => e.kind === 'turn.end')).toBe(true)
    for (const event of mappedEvents) {
      expect(SessionEventSchema.safeParse(event).success).toBe(true)
    }

    const asst = mappedEvents.find((e) => e.kind === 'assistant.message')
    if (asst === undefined || asst.kind !== 'assistant.message') {
      throw new Error('assistant.message missing from fixture')
    }
    expect(asst.text).toContain('Done. Called todo_write and stopped.')
    expect(asst.model?.model).toBe('deepseek-flash')
  })

  it('forwards conversation content that has no RCP kind as unknown', () => {
    const userWire = wireEventsFromJsonl('follow-live.jsonl').find((e) => e.type === 'user/message')
    expect(userWire).toBeDefined()
    const mapped = userWire === undefined ? null : mapDshEventToRcp(userWire)
    expect(mapped).not.toBeNull()
    expect(mapped?.kind).toBe('unknown')
    if (mapped?.kind === 'unknown') {
      expect(mapped.dshType).toBe('user/message')
      expect(mapped.seq).toBe(userWire?.seq)
    }
  })

  it('maps events from page.json fixture', () => {
    const mapped = wireEventsFromPage()
      .map((event) => mapDshEventToRcp(event))
      .filter((event): event is SessionEvent => event !== null)

    expect(mapped.length).toBeGreaterThan(0)
    for (const event of mapped) {
      expect(SessionEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('maps unknown dsh events to the unknown fallback carrying dshType', () => {
    const mappedUnknown = mapDshEventToRcp(wire('novel/dsh-extension-event', { foo: 'bar' }, { seq: 999, time: 123456 }))
    expect(mappedUnknown).not.toBeNull()
    expect(mappedUnknown?.kind).toBe('unknown')
    if (mappedUnknown && mappedUnknown.kind === 'unknown') {
      expect(mappedUnknown.dshType).toBe('novel/dsh-extension-event')
      expect(mappedUnknown.seq).toBe(999)
      expect(mappedUnknown.at).toBe(123456)
    }
  })

  it('returns null for ignorable and internal dsh events', () => {
    expect(mapDshEventToRcp(wire('tool/call', { callId: 'c', name: 'bash' }, { ignorable: true }))).toBeNull()
    for (const type of [
      'request/header',
      'request/context',
      'step/start',
      'step/end',
      'system/message',
      'session/title',
      'session/title-llm-request',
      'agent/inbox/spliced',
      'permission/preset',
      'sandbox/mode',
      'approval/policy',
      'session/end-seed',
    ]) {
      expect(mapDshEventToRcp(wire(type, { anything: true })), type).toBeNull()
    }
  })

  it('returns null for a malformed envelope', () => {
    expect(mapDshEventToRcp({ type: 'turn/start', seq: -1, time: 1 })).toBeNull()
    expect(mapDshEventToRcp({ type: '', seq: 1, time: 1 })).toBeNull()
    expect(mapDshEventToRcp({ type: 'turn/start', seq: 1.5, time: 1 })).toBeNull()
  })

  it('maps dsh turn end reasons to RCP turn end statuses', () => {
    const end = (data: unknown) => mapDshEventToRcp(wire('turn/end', data, { seq: 7, time: 1_000 }))
    expect(end({ turn: 1, reason: { kind: 'completed' } })).toMatchObject({
      kind: 'turn.end',
      seq: 7,
      at: 1_000,
      status: 'completed',
    })
    expect(end({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })).toMatchObject({
      status: 'cancelled',
    })
    expect(
      end({ turn: 1, reason: { kind: 'error', error: { message: 'provider down', code: 'PROVIDER' } } }),
    ).toMatchObject({ status: 'error', error: 'provider down' })
    expect(end({ turn: 1, reason: { kind: 'interrupted' } })).toMatchObject({ status: 'interrupted' })
    expect(end({ turn: 1, reason: { kind: 'blocked' } })).toMatchObject({ status: 'unknown' })
    expect(end({ turn: 1, reason: { kind: 'max-tokens' } })).toMatchObject({ status: 'unknown' })
  })

  it('maps a dsh tool/call record', () => {
    const mapped = mapDshEventToRcp(
      wire('tool/call', {
        turn: 1,
        step: 2,
        callId: 'call_abc',
        name: 'bash',
        arguments: '{"command":"ls -la"}',
      }),
    )
    expect(mapped).toMatchObject({
      kind: 'tool.call',
      callId: 'call_abc',
      tool: 'bash',
      title: 'bash',
      args: { text: '{"command":"ls -la"}', truncated: false },
    })
    expect(SessionEventSchema.safeParse(mapped).success).toBe(true)
  })

  it('maps a dsh tool/result record from its message block', () => {
    const data = (isError: boolean) => ({
      turn: 1,
      step: 2,
      message: {
        role: 'user',
        source: { kind: 'tool', callId: 'call_abc' },
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_abc',
            isError,
            content: [{ type: 'text', text: 'line1\nline2' }],
          },
        ],
      },
    })
    expect(mapDshEventToRcp(wire('tool/result', data(false)))).toMatchObject({
      kind: 'tool.result',
      callId: 'call_abc',
      status: 'ok',
      output: { text: 'line1\nline2', truncated: false },
    })
    expect(mapDshEventToRcp(wire('tool/result', data(true)))).toMatchObject({ status: 'error' })
    const noBlock = mapDshEventToRcp(wire('tool/result', { message: { content: [], source: { callId: 'call_x' } } }))
    expect(noBlock).toMatchObject({ kind: 'tool.result', callId: 'call_x', status: 'unknown' })
    expect(SessionEventSchema.safeParse(noBlock).success).toBe(true)
  })

  it('maps assistant messages with reasoning, model, and the combined output budget', () => {
    const mapped = mapDshEventToRcp(
      wire('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'thinking…' },
            { type: 'text', text: 'the answer' },
          ],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
        usage: { inputTokens: 3, outputTokens: 4 },
      }),
    )
    expect(mapped).toMatchObject({
      kind: 'assistant.message',
      text: 'the answer',
      reasoning: 'thinking…',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    })

    const encoder = new TextEncoder()
    const long = mapDshEventToRcp(
      wire('assistant/message', {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'r'.repeat(30_000) },
            { type: 'text', text: 'a'.repeat(30_000) },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      }),
    )
    if (long === null || long.kind !== 'assistant.message') throw new Error('assistant.message missing')
    expect(encoder.encode(long.text).length).toBe(30_000)
    expect(encoder.encode(long.reasoning ?? '').length).toBe(2_768)
    expect(encoder.encode(long.text).length + encoder.encode(long.reasoning ?? '').length).toBeLessThanOrEqual(
      MAX_ASSISTANT_TEXT_BYTES,
    )
  })

  it('enforces truncation on tool call args (<= 2 KiB)', () => {
    const smallArgs = { file: 'foo.ts', offset: 1 }
    const smallPreview = createArgsPreview(smallArgs)
    expect(smallPreview.truncated).toBe(false)

    const bigString = 'x'.repeat(4000)
    const bigPreview = createArgsPreview({ data: bigString })
    expect(bigPreview.truncated).toBe(true)
    expect(new TextEncoder().encode(bigPreview.text).length).toBeLessThanOrEqual(MAX_TOOL_ARGS_BYTES)
    expect(bigPreview.bytes).toBe(new TextEncoder().encode(JSON.stringify({ data: bigString })).length)

    expect(createArgsPreview('x'.repeat(MAX_TOOL_ARGS_BYTES)).truncated).toBe(false)
    expect(createArgsPreview('x'.repeat(MAX_TOOL_ARGS_BYTES + 1)).truncated).toBe(true)
  })

  it('enforces head-2k / tail-1k truncation on tool result output (> 3 KiB)', () => {
    const smallOutput = 'Operation succeeded'
    const smallPrev = createOutputPreview(smallOutput)
    expect(smallPrev.truncated).toBe(false)
    expect(smallPrev.text).toBe(smallOutput)

    const bigOutput = 'START_' + 'A'.repeat(5000) + '_END'
    const bigPrev = createOutputPreview(bigOutput)
    expect(bigPrev.truncated).toBe(true)
    expect(bigPrev.text).toContain('START_')
    expect(bigPrev.text).toContain('_END')
    expect(bigPrev.text).toContain('…')

    expect(createOutputPreview('x'.repeat(MAX_TOOL_OUTPUT_BYTES)).truncated).toBe(false)
    const overLimit = createOutputPreview('x'.repeat(MAX_TOOL_OUTPUT_BYTES + 1))
    expect(overLimit.truncated).toBe(true)
    expect(overLimit.text).toBe(
      'x'.repeat(TOOL_OUTPUT_HEAD_BYTES) + '…' + 'x'.repeat(TOOL_OUTPUT_TAIL_BYTES),
    )
  })

  it('truncates on UTF-8 code point boundaries without replacement characters', () => {
    const euroPreview = createOutputPreview('€'.repeat(2_000))
    expect(euroPreview.truncated).toBe(true)
    expect(euroPreview.bytes).toBe(6_000)
    expect(euroPreview.text).not.toContain('\uFFFD')

    const cut = truncateUtf8('€'.repeat(3_000), 1_000)
    expect(new TextEncoder().encode(cut).length).toBe(999)
    expect(cut).toBe('€'.repeat(333))
    expect(cut).not.toContain('\uFFFD')

    expect(truncateUtf8HeadTail('€'.repeat(2_000), TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES)).not.toContain(
      '\uFFFD',
    )
  })

  it('enforces assistant text limit of 32 KiB', () => {
    const longText = 'y'.repeat(50_000)
    const truncated = truncateUtf8(longText, MAX_ASSISTANT_TEXT_BYTES)
    expect(new TextEncoder().encode(truncated).length).toBe(MAX_ASSISTANT_TEXT_BYTES)
  })

  it('maps approval audit events and degrades unfaithful ones to unknown', () => {
    const approvalId = '2b5f6a8e-5c1d-4a2b-9c3e-8f1a2b3c4d5e'
    const asked = mapDshEventToRcp(
      wire('approval/asked', { id: approvalId, toolName: 'bash', callId: 'call_1', reason: 'needs shell' }),
    )
    expect(asked).toMatchObject({
      kind: 'approval.asked',
      id: approvalId,
      toolName: 'bash',
      callId: 'call_1',
    })
    expect(asked).not.toHaveProperty('risk')
    expect(SessionEventSchema.safeParse(asked).success).toBe(true)

    expect(mapDshEventToRcp(wire('approval/asked', { id: 'approval_1', toolName: 'bash' }))?.kind).toBe('unknown')

    const decided = mapDshEventToRcp(
      wire('approval/decided', { id: approvalId, toolName: 'bash', outcome: 'allowed-once' }),
    )
    expect(decided).toMatchObject({ kind: 'approval.decided', toolName: 'bash', outcome: 'allowed-once' })

    // The journal's own decision record has no toolName, so it cannot be represented.
    const journalDecision = mapDshEventToRcp(wire('approval/decided', { id: approvalId, outcome: 'rejected' }))
    expect(journalDecision?.kind).toBe('unknown')
    if (journalDecision?.kind === 'unknown') expect(journalDecision.dshType).toBe('approval/decided')
  })
})

describe('Adapter: live coalescer', () => {
  it('coalesces text deltas into live.delta frames', async () => {
    const emitted: unknown[] = []
    const coalescer = new LiveCoalescer({
      streamCoalesceMs: 10,
      emit: (item) => {
        emitted.push(item)
      },
    })

    await coalescer.handleFrame({
      type: 'start',
      attemptId: 'att_1',
      startedAfterSeq: 10,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toEqual({
      type: 'live.start',
      attempt: 'att_1',
      afterSeq: 10,
    })

    // Feed chunks
    await coalescer.handleFrame({
      type: 'chunk',
      attemptId: 'att_1',
      chunk: { type: 'text-delta', text: 'Hello, ' },
    })
    await coalescer.handleFrame({
      type: 'chunk',
      attemptId: 'att_1',
      chunk: { type: 'text-delta', text: 'world!' },
    })

    // Wait for coalesce timer
    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(emitted.length).toBeGreaterThanOrEqual(2)
    const delta = emitted[1] as Record<string, unknown>
    expect(delta['type']).toBe('live.delta')
    expect(delta['text']).toBe('Hello, world!')
    expect(delta['index']).toBe(0)

    // Feed end
    await coalescer.handleFrame({
      type: 'end',
      attemptId: 'att_1',
      outcome: { kind: 'committed' },
    })

    const last = emitted[emitted.length - 1] as Record<string, unknown>
    expect(last['type']).toBe('live.end')
    expect(last['outcome']).toBe('settled')

    coalescer.dispose()
  })

  it('handles backpressure gracefully', async () => {
    let callCount = 0
    const coalescer = new LiveCoalescer({
      streamCoalesceMs: 5,
      emit: () => {
        callCount++
        return false // simulate backpressure refusal
      },
    })

    await coalescer.handleFrame({
      type: 'start',
      attemptId: 'att_bp',
      startedAfterSeq: 0,
    })

    await coalescer.handleFrame({
      type: 'chunk',
      attemptId: 'att_bp',
      chunk: { type: 'text-delta', text: 'dropped delta' },
    })

    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(callCount).toBeGreaterThan(0)
    coalescer.dispose()
  })
})

describe('Adapter: gateway & error mapping', () => {
  it('maps dsh error codes correctly', () => {
    for (const [dshCode, expectedRcpCode] of Object.entries(DSH_ERROR_CODE_MAP)) {
      const mapped = mapDshErrorToRcp({ code: dshCode, message: 'some failure' })
      expect(mapped.code).toBe(expectedRcpCode)
      expect(mapped.details?.dsh).toBe(dshCode)
    }

    const abortError = mapDshErrorToRcp({ name: 'AbortError' })
    expect(abortError.code).toBe(RCP_ERROR_CODES.cancelled)
  })

  it('invokes gateway create, list, and prompt correctly', async () => {
    const invokedCalls: unknown[] = []
    const fakeGateway: TypertGateway = {
      invoke: async (req) => {
        invokedCalls.push(req)
        if (req.method === 'list') {
          return { items: [{ sessionId: 's_1', cwd: 'C:\\test', running: true }] }
        }
        if (req.method === 'create') {
          return { sessionId: 's_created', agentPreset: 'standard' }
        }
        if (req.method === 'prompt') {
          return { accepted: true }
        }
        return {}
      },
      stream: async () => {
        return (async function* () {})()
      },
    }

    const created = await gatewaySessionCreate(fakeGateway, { cwd: 'C:\\test' })
    expect(created.sessionId).toBe('s_created')

    const listed = await gatewaySessionList(fakeGateway)
    expect(listed.items).toHaveLength(1)

    const prompted = await gatewaySessionPrompt(fakeGateway, {
      sessionId: 's_created',
      requestId: '00000000-0000-4000-8000-000000000001',
      mode: 'queue',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(prompted.accepted).toBe(true)
  })
})

describe('Adapter: sessions', () => {
  const fakeListRaw = JSON.parse(
    fs.readFileSync(path.join(FIXTURES_DIR, 'list.json'), 'utf8'),
  )

  it('lists sessions from fixture', async () => {
    const fakeGateway: TypertGateway = {
      invoke: async () => fakeListRaw,
      stream: async () => (async function* () {})(),
    }
    const adapter = new SessionAdapter({ gateway: fakeGateway })
    const res = await adapter.list({ limit: 10 })

    expect(res.items.length).toBeGreaterThan(0)
    const first = res.items[0]!
    expect(first.id).toBe('session-8d4eacb4-0e4e-4e83-bf6a-00321a631694')
    expect(first.title).toBe('Call todo_write once with a')
    expect(first.status).toBe('running')
    expect(first.workspace.path).toContain('remora-p0-s1')
  })

  it('deduplicates prompt requests by requestId', async () => {
    let callCount = 0
    const fakeGateway: TypertGateway = {
      invoke: async (req) => {
        if (req.method === 'prompt') callCount++
        return { accepted: true }
      },
      stream: async () => (async function* () {})(),
    }
    const adapter = new SessionAdapter({ gateway: fakeGateway })
    const requestId = '11111111-1111-4111-8111-111111111111'

    const r1 = await adapter.prompt({
      sessionId: 's_1',
      requestId,
      text: 'do something',
      delivery: 'queue',
    })
    expect(r1.accepted).toBe(true)
    expect(r1.duplicate).toBe(false)
    expect(callCount).toBe(1)

    // Second call with same requestId
    const r2 = await adapter.prompt({
      sessionId: 's_1',
      requestId,
      text: 'do something',
      delivery: 'queue',
    })
    expect(r2.accepted).toBe(true)
    expect(r2.duplicate).toBe(true)
    // Gateway was not called again
    expect(callCount).toBe(1)
  })

  it('packs snapshot <= 48 KiB with hasOlder flag', async () => {
    const events: SessionEvent[] = []
    for (let i = 0; i < 1500; i++) {
      events.push({
        kind: 'turn.start',
        seq: i,
        at: 1000 + i,
      })
    }

    const itemsEmitted: unknown[] = []
    const fakeSink: RcpStreamSink = {
      sid: 1,
      deviceId: 'd_test',
      channelId: 1,
      signal: new AbortController().signal,
      sendItem: async (d) => {
        itemsEmitted.push(d)
        return true
      },
      end: async () => true,
    }

    const fakeGateway: TypertGateway = {
      invoke: async () => ({}),
      stream: async function* () {
        yield {
          type: 'snapshot',
          header: { id: 's_packed', createdAt: 1000, version: 1, isSeeded: false },
          cursor: 500,
          records: events.map((e) => ({
            type: 'event',
            event: { type: 'turn/start', seq: e.seq, time: e.at, data: {} },
          })),
          hasMore: false,
        }
      },
    }

    const adapter = new SessionAdapter({ gateway: fakeGateway })
    await adapter.follow({ sessionId: 's_packed' }, fakeSink)

    // Wait for stream to deliver snapshot
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(itemsEmitted).toHaveLength(1)
    const snap = itemsEmitted[0] as { type: string; events: SessionEvent[]; hasOlder: boolean }
    expect(snap.type).toBe('snapshot')
    expect(snap.hasOlder).toBe(true) // 500 events exceeded budget
    const serializedBytes = new TextEncoder().encode(JSON.stringify(snap)).length
    expect(serializedBytes).toBeLessThanOrEqual(48_000)
  })

  it('resumes follow with afterSeq when contiguous', async () => {
    const itemsEmitted: unknown[] = []
    const fakeSink: RcpStreamSink = {
      sid: 2,
      deviceId: 'd_test',
      channelId: 1,
      signal: new AbortController().signal,
      sendItem: async (d) => {
        itemsEmitted.push(d)
        return true
      },
      end: async () => true,
    }

    const fakeGateway: TypertGateway = {
      invoke: async () => ({}),
      stream: async function* () {
        yield {
          type: 'snapshot',
          header: { id: 's_resume', createdAt: 1000, version: 1, isSeeded: false },
          cursor: 15,
          records: [
            { type: 'event', event: { type: 'turn/start', seq: 10, time: 1000, data: {} } },
            { type: 'event', event: { type: 'turn/start', seq: 11, time: 1001, data: {} } },
            { type: 'event', event: { type: 'turn/start', seq: 12, time: 1002, data: {} } },
          ],
          hasMore: false,
        }
      },
    }

    const adapter = new SessionAdapter({ gateway: fakeGateway })
    await adapter.follow({ sessionId: 's_resume', afterSeq: 10 }, fakeSink)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(itemsEmitted).toHaveLength(1)
    const evtItem = itemsEmitted[0] as { type: string; events: SessionEvent[] }
    expect(evtItem.type).toBe('events')
    expect(evtItem.events).toHaveLength(2)
    expect(evtItem.events[0]?.seq).toBe(11)
    expect(evtItem.events[1]?.seq).toBe(12)
  })

  it('detects resume gap and sends reset then snapshot', async () => {
    const itemsEmitted: unknown[] = []
    const fakeSink: RcpStreamSink = {
      sid: 3,
      deviceId: 'd_test',
      channelId: 1,
      signal: new AbortController().signal,
      sendItem: async (d) => {
        itemsEmitted.push(d)
        return true
      },
      end: async () => true,
    }

    const fakeGateway: TypertGateway = {
      invoke: async () => ({}),
      stream: async function* () {
        yield {
          type: 'snapshot',
          header: { id: 's_gap', createdAt: 1000, version: 1, isSeeded: false },
          cursor: 50,
          records: [
            { type: 'event', event: { type: 'turn/start', seq: 40, time: 1000, data: {} } },
          ],
          hasMore: false,
        }
      },
    }

    const adapter = new SessionAdapter({ gateway: fakeGateway })
    // Client asks for seq 5, but records only start at seq 40
    await adapter.follow({ sessionId: 's_gap', afterSeq: 5 }, fakeSink)

    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(itemsEmitted).toHaveLength(2)
    const reset = itemsEmitted[0] as { type: string; reason: string }
    expect(reset.type).toBe('reset')
    expect(reset.reason).toBe('cursor_unavailable')

    const snap = itemsEmitted[1] as { type: string; events: SessionEvent[] }
    expect(snap.type).toBe('snapshot')
    expect(snap.events[0]?.seq).toBe(40)
  })

  it('integrates with RcpServer and handles full RPC session dispatch', async () => {
    const fakeGateway: TypertGateway = {
      invoke: async (req) => {
        if (req.method === 'list') return fakeListRaw
        if (req.method === 'prompt') return { accepted: true }
        if (req.method === 'cancel') return { accepted: true }
        if (req.method === 'rename') return { title: 'New Title', seq: 25 }
        if (req.method === 'page') return { records: [], hasMore: false }
        return {}
      },
      stream: async function* () {
        yield {
          type: 'snapshot',
          header: { id: 'session-8d4eacb4-0e4e-4e83-bf6a-00321a631694', createdAt: 1000, version: 1, isSeeded: false },
          cursor: 2,
          records: [],
          hasMore: false,
        }
        await new Promise((_resolve) => {
          // Keep stream open
        })
      },
    }

    const server = new RcpServer({
      hostId: 'h_test1234567890',
      hostName: 'test-pc',
    })
    const adapter = new SessionAdapter({ gateway: fakeGateway })
    registerSessionMethods(server, adapter)

    const ctx = { deviceId: 'd_test1234567890', channelId: 1 }

    // Test sessions.list
    const listResRaw = await server.handleMessage(
      JSON.stringify({ k: 'req', id: 1, m: 'sessions.list', p: { limit: 5 } }),
      ctx,
    )
    expect(listResRaw).not.toBeNull()
    const listRes = JSON.parse(listResRaw!)
    expect(listRes.ok).toBe(true)
    expect(listRes.r.items.length).toBeGreaterThan(0)

    // Test sessions.prompt
    const promptResRaw = await server.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 2,
        m: 'sessions.prompt',
        p: {
          sessionId: 'session-8d4eacb4-0e4e-4e83-bf6a-00321a631694',
          requestId: '22222222-2222-4222-8222-222222222222',
          text: 'hello',
          delivery: 'queue',
        },
      }),
      ctx,
    )
    expect(promptResRaw).not.toBeNull()
    const promptRes = JSON.parse(promptResRaw!)
    expect(promptRes.ok).toBe(true)
    expect(promptRes.r.accepted).toBe(true)

    // Test sessions.follow
    const followResRaw = await server.handleMessage(
      JSON.stringify({
        k: 'req',
        id: 3,
        m: 'sessions.follow',
        p: { sessionId: 'session-8d4eacb4-0e4e-4e83-bf6a-00321a631694' },
      }),
      ctx,
    )
    expect(followResRaw).not.toBeNull()
    const followRes = JSON.parse(followResRaw!)
    expect(followRes.ok).toBe(true)
    expect(typeof followRes.r.sid).toBe('number')
    expect(server.activeStreamCount(ctx.deviceId)).toBe(1)
  })
})
