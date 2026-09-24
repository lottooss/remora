import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RCP_ERROR_CODES,
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
  createArgsPreview,
  createOutputPreview,
  mapDshEventToRcp,
  truncateUtf8,
  type DshWireEvent,
} from '../src/adapter/event-map.ts'
import { LiveCoalescer } from '../src/adapter/live.ts'
import { SessionAdapter } from '../src/adapter/sessions.ts'
import { RcpServer, type RcpStreamSink } from '../src/rcp/index.ts'
import { registerSessionMethods } from '../src/rcp/methods/sessions.ts'

const FIXTURES_DIR = path.resolve(__dirname, 'fixtures/dsh-0.1.5-rc.3')

describe('Adapter: event-map', () => {
  it('maps events from follow-opening.jsonl', () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'follow-opening.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
    const snapshotFrame = lines[0]
    expect(snapshotFrame.type).toBe('snapshot')

    const mappedEvents = []
    for (const rec of snapshotFrame.records) {
      if (rec.type === 'event') {
        const mapped = mapDshEventToRcp(rec.event)
        if (mapped) mappedEvents.push(mapped)
      }
    }

    expect(mappedEvents.length).toBeGreaterThan(0)
    expect(mappedEvents.some((e) => e.kind === 'turn.start')).toBe(true)
    expect(mappedEvents.some((e) => e.kind === 'assistant.message')).toBe(true)
    expect(mappedEvents.some((e) => e.kind === 'turn.end')).toBe(true)

    const asst = mappedEvents.find((e) => e.kind === 'assistant.message')
    if (asst && asst.kind === 'assistant.message') {
      expect(asst.text).toContain('Done. Called todo_write and stopped.')
      expect(asst.model?.model).toBe('deepseek-flash')
    }
  })

  it('maps events from page.json fixture', () => {
    const raw = fs.readFileSync(path.join(FIXTURES_DIR, 'page.json'), 'utf8')
    const pageData = JSON.parse(raw)
    const mapped = []

    for (const rec of pageData.records) {
      if (rec.type === 'event') {
        const ev = mapDshEventToRcp(rec.event)
        if (ev) mapped.push(ev)
      }
    }

    expect(mapped.length).toBeGreaterThan(0)
    // Check unknown events fallback
    const unknownWire: DshWireEvent = {
      type: 'novel/dsh-extension-event',
      seq: 999,
      time: 123456,
      data: { foo: 'bar' },
    }
    const mappedUnknown = mapDshEventToRcp(unknownWire)
    expect(mappedUnknown).not.toBeNull()
    expect(mappedUnknown?.kind).toBe('unknown')
    if (mappedUnknown && mappedUnknown.kind === 'unknown') {
      expect(mappedUnknown.dshType).toBe('novel/dsh-extension-event')
    }
  })

  it('enforces truncation on tool call args (<= 2 KiB)', () => {
    const smallArgs = { file: 'foo.ts', offset: 1 }
    const smallPreview = createArgsPreview(smallArgs)
    expect(smallPreview.truncated).toBe(false)

    const bigString = 'x'.repeat(4000)
    const bigPreview = createArgsPreview({ data: bigString })
    expect(bigPreview.truncated).toBe(true)
    expect(new TextEncoder().encode(bigPreview.text).length).toBeLessThanOrEqual(2048)
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
  })

  it('enforces assistant text limit of 32 KiB', () => {
    const longText = 'y'.repeat(50_000)
    const truncated = truncateUtf8(longText, 32768)
    expect(new TextEncoder().encode(truncated).length).toBe(32768)
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
