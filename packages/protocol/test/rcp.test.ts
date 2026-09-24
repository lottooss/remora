import { describe, expect, it } from 'vitest'

import {
  MessageSchema,
  RCP_ERROR_CODES,
  RCP_METHODS,
  RCP_METHODS_BY_NAME,
  RCP_METHOD_NAMES,
  RcpErrorSchema,
  SessionEventSchema,
  createRcpError,
} from '../src/rcp/index.ts'

const EXPECTED_METHODS: ReadonlyArray<{
  name: string
  kind: 'unary' | 'stream'
  mutating: boolean
}> = [
  { name: 'hello', kind: 'unary', mutating: false },
  { name: 'ping', kind: 'unary', mutating: false },
  { name: 'host.status', kind: 'unary', mutating: false },
  { name: 'sessions.list', kind: 'unary', mutating: false },
  { name: 'sessions.get', kind: 'unary', mutating: false },
  { name: 'sessions.create', kind: 'unary', mutating: true },
  { name: 'sessions.prompt', kind: 'unary', mutating: true },
  { name: 'sessions.cancel', kind: 'unary', mutating: true },
  { name: 'sessions.follow', kind: 'stream', mutating: false },
  { name: 'sessions.page', kind: 'unary', mutating: false },
  { name: 'sessions.eventText', kind: 'unary', mutating: false },
  { name: 'sessions.toolOutput', kind: 'unary', mutating: false },
  { name: 'sessions.control', kind: 'stream', mutating: false },
  { name: 'sessions.queue.update', kind: 'unary', mutating: true },
  { name: 'sessions.rename', kind: 'unary', mutating: true },
  { name: 'sessions.selectModel', kind: 'unary', mutating: true },
  { name: 'workspaces.list', kind: 'unary', mutating: false },
  { name: 'workspaces.create', kind: 'unary', mutating: true },
  { name: 'fs.browse', kind: 'unary', mutating: false },
  { name: 'fs.mkdir', kind: 'unary', mutating: true },
  { name: 'files.read', kind: 'unary', mutating: false },
  { name: 'files.readBytes', kind: 'unary', mutating: false },
  { name: 'diffs.get', kind: 'unary', mutating: false },
  { name: 'diffs.status', kind: 'unary', mutating: false },
  { name: 'diffs.hunk', kind: 'unary', mutating: false },
  { name: 'interaction.follow', kind: 'stream', mutating: false },
  { name: 'approvals.answer', kind: 'unary', mutating: true },
  { name: 'questions.answer', kind: 'unary', mutating: true },
  { name: 'devices.list', kind: 'unary', mutating: false },
  { name: 'devices.rename', kind: 'unary', mutating: true },
  { name: 'devices.revoke', kind: 'unary', mutating: true },
  { name: 'devices.rotateApprovalKey', kind: 'unary', mutating: true },
  { name: 'notify.prefs.get', kind: 'unary', mutating: false },
  { name: 'notify.prefs.set', kind: 'unary', mutating: true },
  { name: 'models.catalog', kind: 'unary', mutating: false },
]

const EMPTY_PARAMS_METHODS = new Set([
  'host.status',
  'sessions.list',
  'sessions.control',
  'workspaces.list',
  'fs.browse',
  'interaction.follow',
  'devices.list',
  'notify.prefs.get',
  'models.catalog',
])

describe('RCP/1 method registry', () => {
  it('contains every method in RCP/1 §11, in spec order', () => {
    expect(RCP_METHODS.map((method) => method.name)).toEqual(
      EXPECTED_METHODS.map((expected) => expected.name),
    )
    expect(RCP_METHOD_NAMES).toEqual(EXPECTED_METHODS.map((expected) => expected.name))
    expect(RCP_METHODS).toHaveLength(EXPECTED_METHODS.length)
    expect(EXPECTED_METHODS).toHaveLength(35)
  })

  it('indexes every method by name with matching metadata', () => {
    const keys = Object.keys(RCP_METHODS_BY_NAME)
    expect(keys).toHaveLength(EXPECTED_METHODS.length)
    for (const expected of EXPECTED_METHODS) {
      const method = RCP_METHODS_BY_NAME[expected.name as keyof typeof RCP_METHODS_BY_NAME]
      expect(method).toBeDefined()
      expect(method?.name).toBe(expected.name)
      expect(method?.kind).toBe(expected.kind)
      expect(method?.mutating).toBe(expected.mutating)
      expect(method?.paramsSchema).toBeDefined()
      expect(method?.resultSchema).toBeDefined()
      if (expected.kind === 'stream') {
        expect(method?.kind).toBe('stream')
        expect(method && 'itemSchema' in method ? method.itemSchema : undefined).toBeDefined()
      } else {
        expect(method && 'itemSchema' in method ? method.itemSchema : undefined).toBeUndefined()
      }
    }
  })

  it('validates params shapes: empty-params methods accept {}, the rest reject', () => {
    for (const method of RCP_METHODS) {
      const acceptsEmpty = method.paramsSchema.safeParse({}).success
      expect(acceptsEmpty).toBe(EMPTY_PARAMS_METHODS.has(method.name))
    }
  })

  it('opens every stream with a { sid } result and rejects a bad stream open', () => {
    for (const method of RCP_METHODS) {
      if (method.kind !== 'stream') continue
      expect(method.resultSchema.safeParse({ sid: 7 }).success).toBe(true)
      expect(method.resultSchema.safeParse({}).success).toBe(false)
    }
  })
})

describe('RCP/1 envelope validation', () => {
  const validMessages: unknown[] = [
    { k: 'req', id: 1, m: 'ping', p: { t: 1_700_000_000_000 } },
    { k: 'req', id: 2, m: 'host.status' },
    { k: 'res', id: 1, ok: true, r: { t: 1, hostTime: 2 } },
    { k: 'res', id: 2, ok: true },
    {
      k: 'res',
      id: 3,
      ok: false,
      e: { code: 'rate_limited', message: 'slow down', retryAfterMs: 500 },
    },
    { k: 'item', sid: 9, n: 0, d: { type: 'baseline', sessions: [] } },
    { k: 'end', sid: 9, ok: true },
    { k: 'end', sid: 9, ok: false, e: { code: 'internal_error', message: 'boom' } },
    { k: 'cancel', sid: 9 },
    { k: 'evt', e: 'pair.rejected', d: { reason: 'timeout' } },
  ]

  it.each(validMessages)('accepts a valid envelope: %j', (message) => {
    expect(MessageSchema.safeParse(message).success).toBe(true)
  })

  it('keeps unknown fields on valid envelopes (passthrough)', () => {
    const parsed = MessageSchema.parse({
      k: 'cancel',
      sid: 3,
      futureField: { keep: true },
    })
    expect(parsed).toEqual({ k: 'cancel', sid: 3, futureField: { keep: true } })
  })

  const invalidMessages: unknown[] = [
    null,
    42,
    'req',
    {},
    { k: 'unknown' },
    { k: 'req' },
    { k: 'req', id: 1 },
    { k: 'req', id: 1, m: '' },
    { k: 'req', id: -1, m: 'ping' },
    { k: 'req', id: 1.5, m: 'ping' },
    { k: 'req', id: 4_294_967_296, m: 'ping' },
    { k: 'req', id: '1', m: 'ping' },
    { k: 'res', id: 1 },
    { k: 'res', id: 1, ok: 'yes' },
    { k: 'res', id: 1, ok: false },
    { k: 'res', id: 1, ok: false, e: {} },
    { k: 'res', id: 1, ok: false, e: { message: 'no code' } },
    { k: 'item', sid: 1 },
    { k: 'item', sid: 1, n: -1, d: {} },
    { k: 'item', sid: 1, n: 0 },
    { k: 'item', sid: 1, n: 0, d: 'payload' },
    { k: 'end', sid: 1 },
    { k: 'end', sid: 1, ok: 'true' },
    { k: 'cancel' },
    { k: 'cancel', sid: -1 },
    { k: 'evt', e: 'x' },
    { k: 'evt', d: {} },
  ]

  it.each(invalidMessages)('rejects an invalid envelope: %j', (message) => {
    expect(MessageSchema.safeParse(message).success).toBe(false)
  })
})

describe('RCP/1 errors', () => {
  it('exposes the RCP/1 error code constants', () => {
    expect(Object.values(RCP_ERROR_CODES)).toEqual([
      'invalid_request',
      'method_not_found',
      'invalid_params',
      'unauthorized',
      'forbidden',
      'not_found',
      'conflict',
      'rate_limited',
      'too_large',
      'cancelled',
      'internal_error',
    ])
  })

  it('builds and validates an RcpError', () => {
    const error = createRcpError('rate_limited', 'too many requests', { by: 'system' }, 1_000)
    expect(error).toEqual({
      code: 'rate_limited',
      message: 'too many requests',
      retryAfterMs: 1_000,
      details: { by: 'system' },
    })
    expect(RcpErrorSchema.safeParse(error).success).toBe(true)
    expect(RcpErrorSchema.safeParse({ message: 'missing code' }).success).toBe(false)
    expect(
      RcpErrorSchema.safeParse({ code: 'novel_code', message: 'from the future' }).success,
    ).toBe(true)
  })
})

describe('RCP/1 session events', () => {
  it('decodes known kinds with their fields intact', () => {
    const event = SessionEventSchema.parse({
      kind: 'tool.call',
      seq: 4,
      at: 1_700_000_000_000,
      callId: 'c1',
      tool: 'shell',
      title: 'List files',
      args: { text: 'ls', bytes: 2, truncated: false },
      vendorExtension: { keep: true },
    })
    expect(event).toEqual({
      kind: 'tool.call',
      seq: 4,
      at: 1_700_000_000_000,
      callId: 'c1',
      tool: 'shell',
      title: 'List files',
      args: { text: 'ls', bytes: 2, truncated: false },
      vendorExtension: { keep: true },
    })
  })

  it('falls back to kind "unknown" for a novel dsh type without failing', () => {
    const event = SessionEventSchema.parse({
      kind: 'totally.future.kind',
      seq: 9,
      at: 10,
      payload: { anything: 1 },
    })
    expect(event).toEqual({
      kind: 'unknown',
      dshType: 'totally.future.kind',
      seq: 9,
      at: 10,
      payload: { anything: 1 },
    })
  })

  it('keeps an explicit unknown event', () => {
    const event = SessionEventSchema.parse({ kind: 'unknown', dshType: 'legacy.type' })
    expect(event).toEqual({ kind: 'unknown', dshType: 'legacy.type' })
  })

  it('fails closed when a known kind is missing required fields', () => {
    expect(SessionEventSchema.safeParse({ kind: 'tool.call', vendorField: 1 }).success).toBe(false)
    expect(
      SessionEventSchema.parse({ kind: 'turn.end', seq: 1, at: 1 }),
    ).toMatchObject({ kind: 'turn.end', status: 'unknown' })
  })

  it('decodes unknown enum values to their documented fallbacks', () => {
    expect(
      SessionEventSchema.parse({ kind: 'turn.end', seq: 1, at: 1, status: 'something-new' }),
    ).toMatchObject({ kind: 'turn.end', status: 'unknown' })
    expect(
      SessionEventSchema.parse({
        kind: 'tool.result',
        seq: 2,
        at: 1,
        callId: 'c1',
        status: 'weird',
        output: { text: '', bytes: 0, truncated: false },
      }),
    ).toMatchObject({ kind: 'tool.result', status: 'unknown' })
    expect(
      SessionEventSchema.parse({ kind: 'session.status', seq: 3, at: 1, sessionId: 's1', status: 'zzz' }),
    ).toMatchObject({ kind: 'session.status', status: 'unknown' })
    expect(
      SessionEventSchema.parse({
        kind: 'approval.asked',
        seq: 5,
        at: 1,
        id: '2b5f6a8e-5c1d-4a2b-9c3e-8f1a2b3c4d5e',
        toolName: 'shell',
        risk: 'extreme',
      }),
    ).toMatchObject({ kind: 'approval.asked', risk: 'high' })
  })
})
