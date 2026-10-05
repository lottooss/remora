/**
 * Authors deterministic RCP golden assets from explicit reviewed examples.
 * Deliberately imports no implementation/schema and never computes an expected
 * result by running the implementation under test. Running this writes assets
 * only; it does not establish validation, conformance, or runtime evidence.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..') // repository root
const out = resolve(root, 'conformance/vectors')
const source = 'Authored deterministic examples in packages/protocol/scripts/gen-rcp-vectors.mjs from RCP/1 and existing TS schemas; not captured implementation output; execution/independent verification deferred.'
const id = '11111111-2222-4333-8444-555555555555'
const sessionId = 'session-vector-1'
const workspaceId = 'workspace-vector-1'
const at = 1791158400000
const path = 'C:\\Projects\\remora'
const model = { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' }
const workspace = { id: workspaceId, title: 'Remora', path, remoteAllowed: true }
const session = { id: sessionId, title: 'Review changes', workspace: { id: workspaceId, path, title: 'Remora' }, status: 'idle', updatedAt: at, model }
const prefs = { approval: true, question: true, turnDone: false, turnError: true }
const event = { kind: 'assistant.message', seq: 3, at, text: 'Ready to review.', model }
const digest = 'sha256:' + '0'.repeat(64)
const approval = { kind: 'approval', id, sessionId, sessionTitle: 'Review changes', toolName: 'shell', callId: 'call-1', preview: { text: 'Run git status', json: '{"command":"git status"}' }, argsDigest: digest, risk: 'normal', requiresSignature: false, createdAt: at, expiresAt: at + 60000 }
const question = { kind: 'question', id, sessionId, sessionTitle: null, questions: [{ id: 'q-1', question: 'Which checks?', options: [{ label: 'Types', description: 'Static compilation' }, { label: 'Lint' }], multiSelect: true }], createdAt: at, expiresAt: at + 60000 }

// Each row: method, valid params, valid result, invalid params. Invalid values
// are explicit malformed inputs, not failures harvested from the implementation.
const rows = [
  ['hello', { rcp: [1], app: { name: 'remora-android', version: '1.0.0', build: 7 } }, { rcp: 1, host: { id: 'h_aaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'Vector host', os: 'win32', pathSeparator: '\\', versions: { remora: '1.0.0', dsh: '0.1.5-rc.3' } }, features: ['sessions','interaction','workspaces','files','diffs.git','notify','models'], roots: [path], policy: { approvalBiometric: 'high', allowRemoteSessionStart: true }, limits: { maxMessageBytes: 49152, maxStreams: 10 }, time: at }, { rcp: '1', app: { name: 'remora-android', version: '1.0.0' } }],
  ['ping', { t: at }, { t: at, hostTime: at + 12 }, { t: 'now' }],
  ['host.status', {}, { uptimeMs: 12000, agentsRunning: 2, keepAwake: true, dsh: { version: '0.1.5-rc.3', profile: 'remora' } }, null],
  ['sessions.list', { limit: 25, includeArchived: false }, { items: [session], next: 'page-2' }, { limit: 101 }],
  ['sessions.search', { query: 'review' }, { results: [{ sessionId, title: 'Review changes', snippet: 'Ready to review.', at }] }, { query: '' }],
  ['sessions.follow', { sessionId, afterSeq: 2, live: true }, { sid: 9 }, { sessionId, afterSeq: -1 }],
  ['sessions.page', { sessionId, beforeSeq: 4, limit: 25 }, { events: [event], hasOlder: false }, { sessionId, beforeSeq: 4, limit: 0 }],
  ['sessions.eventText', { sessionId, seq: 3, offset: 0, limit: 1024 }, { text: 'Ready to review.', offset: 0, eof: true }, { sessionId, seq: 3, offset: -1 }],
  ['sessions.toolOutput', { sessionId, callId: 'call-1', offset: 0, limit: 1024 }, { text: 'clean\n', offset: 0, total: 6, eof: true }, { sessionId, callId: '', offset: 0 }],
  ['sessions.prompt', { sessionId, requestId: id, text: 'Review the changes.', delivery: 'queue' }, { accepted: true, duplicate: false }, { sessionId, requestId: id, text: '', delivery: 'queue' }],
  ['sessions.cancel', { sessionId, requestId: id }, { requested: true }, { sessionId, requestId: 'not-a-uuid' }],
  ['sessions.queue.update', { sessionId, itemId: 'queued-1', action: 'edit', text: 'Review only the staged changes.', requestId: id }, { ok: true }, { sessionId, itemId: 'queued-1', action: 'drop', requestId: id }],
  ['sessions.create', { requestId: id, workspace: { id: workspaceId }, model }, { sessionId, workspaceId }, { requestId: id, workspace: {} }],
  ['sessions.rename', { sessionId, title: 'Staged changes', requestId: id }, { title: 'Staged changes' }, { sessionId, title: '', requestId: id }],
  ['sessions.selectModel', { sessionId, model, requestId: id }, { model }, { sessionId, model: { provider: 'deepseek' }, requestId: id }],
  ['sessions.control', {}, { sid: 10 }, []],
  ['models.catalog', {}, { providers: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', reasoningEfforts: ['high'] }] }], default: model }, null],
  ['workspaces.follow', {}, { sid: 11 }, false],
  ['workspaces.list', {}, { workspaces: [workspace] }, []],
  ['workspaces.create', { path, requestId: id }, { workspace, created: true }, { path: '', requestId: id }],
  ['fs.browse', { path }, { path, parent: 'C:\\Projects', entries: [{ name: 'src', kind: 'dir' }, { name: 'README.md', kind: 'file' }], truncated: false }, { path: 42 }],
  ['fs.mkdir', { parent: path, name: 'reports', requestId: id }, { path: path + '\\reports' }, { parent: path, name: '..', requestId: id }],
  ['devices.self', {}, { id: 'd_bbbbbbbbbbbbbbbbbbbbbbbbbb', name: 'Vector phone', pairedAt: at, approvalKey: { hardwareBacked: null } }, null],
  ['devices.unpair', { requestId: id }, { ok: true }, { requestId: '11111111-2222-4333-8444-ABCDEFABCDEF' }],
  ['devices.rotateApprovalKey', { approvalPub: 'AQIDBA', requestId: id }, { status: 'pending_pc_confirmation' }, { approvalPub: 'AQIDBA==', requestId: id }],
  ['interaction.follow', {}, { sid: 12 }, 'empty'],
  ['approvals.answer', { id, outcome: 'rejected', argsDigest: digest, issuedAt: at }, { accepted: true, final: 'rejected', by: 'phone' }, { id, outcome: 'cancelled', argsDigest: digest, issuedAt: at }],
  ['questions.answer', { id, answers: [{ id: 'q-1', selected: ['Types', 'Lint'], custom: 'Only changed files' }] }, { accepted: true, by: 'phone' }, { id, answers: [{ id: 'q-1', selected: 'Types' }] }],
  ['files.list', { sessionId, path }, { path, entries: [{ name: 'README.md', kind: 'file', bytes: 7 }], truncated: false }, { sessionId, path: '' }],
  ['files.stat', { sessionId, path: path + '\\README.md' }, { path: path + '\\README.md', bytes: 7, version: 'v-1' }, { path }],
  ['files.read', { sessionId, path: path + '\\README.md', offset: 1, limit: 100 }, { path: path + '\\README.md', version: 'v-1', offset: 1, text: 'Remora\n', lines: 1, eof: true, bytes: 7 }, { sessionId, path, offset: 0 }],
  ['files.changes', { sessionId }, { sid: 13 }, { sessionId: '' }],
  ['diffs.status', { sessionId }, { source: 'git', branch: 'main', files: [{ path: 'README.md', status: 'M', adds: 2, dels: 1 }], truncated: false }, { sessionId: null }],
  ['diffs.file', { sessionId, path: path + '\\README.md', fromHunk: 0 }, { path: path + '\\README.md', binary: false, hunks: [{ header: '@@ -1 +1 @@', lines: ['-Old', '+New'] }], nextHunk: 1 }, { sessionId, path, fromHunk: -1 }],
  ['notify.prefs.get', {}, prefs, null],
  ['notify.prefs.set', prefs, prefs, { approval: true, question: true, turnDone: false }],
]

const good = (name, direction, value, expected = value) => ({ name, input: { direction, value }, expect: expected })
const bad = (name, direction, value, error) => ({ name, input: { direction, value }, error })
const write = (suite, cases, notes, filePath = suite) => {
  const file = resolve(out, filePath + '.json')
  mkdirSync(resolve(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ suite, version: 1, source, notes, cases }, null, 2) + '\n')
}
const methodNotes = 'input.direction chooses params/result/item/error; value is the actual JSON payload. expect is the decoded payload; error labels invalid_params/invalid_result/invalid_item/invalid_error are corpus validation categories, not host execution results. No approval digest/signature validity, policy enforcement, or exactly-once effects are claimed. Method name comes from the filename; suite labels are lowercase to satisfy the existing vector-file schema.'
for (const [method, params, result, invalid] of rows) {
  const cases = [good('valid request parameters', 'params', params), good('valid response payload', 'result', result), bad('malformed request parameters', 'params', invalid, 'invalid_params'), bad('malformed response payload', 'result', {}, 'invalid_result'), good('not found error payload', 'error', { code: 'not_found', message: 'Requested resource is unavailable.' })]
  if (method === 'sessions.follow') cases.push(
    good('snapshot with retained transcript', 'item', { type: 'snapshot', session, events: [event], hasOlder: false }),
    good('durable events batch', 'item', { type: 'events', events: [event] }),
    good('live attempt starts', 'item', { type: 'live.start', attempt: 'attempt-1', afterSeq: 3 }),
    good('coalesced live delta', 'item', { type: 'live.delta', attempt: 'attempt-1', index: 0, text: 'Next', reasoning: 'Review' }),
    good('live attempt settles', 'item', { type: 'live.end', attempt: 'attempt-1', outcome: 'settled' }),
    good('cursor reset', 'item', { type: 'reset', reason: 'cursor_unavailable' }),
    bad('negative live index', 'item', { type: 'live.delta', attempt: 'attempt-1', index: -1 }, 'invalid_item'))
  if (method === 'sessions.control') {
    const control = { sessionId, running: true, queue: [{ itemId: 'queued-1', text: 'Review', delivery: 'queue' }], jobs: [{ id: 'job-1', title: 'Index', state: 'running' }] }
    cases.push(good('complete control baseline', 'item', { type: 'baseline', sessions: [control] }), good('complete control replacement', 'item', { type: 'update', session: control }), good('disposed session', 'item', { type: 'removed', sessionId }), bad('incomplete control state', 'item', { type: 'update', session: { sessionId, running: true } }, 'invalid_item'))
  }
  if (method === 'workspaces.follow') cases.push(good('workspace baseline', 'item', { type: 'baseline', workspaces: [workspace] }), good('workspace upsert', 'item', { type: 'upsert', workspace }), good('workspace removal', 'item', { type: 'removed', id: workspaceId }), bad('missing workspace', 'item', { type: 'upsert' }, 'invalid_item'))
  if (method === 'interaction.follow') cases.push(good('pending baseline', 'item', { type: 'baseline', pending: [approval, question] }), good('requested question', 'item', { type: 'requested', pending: question }), good('resolution by PC', 'item', { type: 'resolved', id, outcome: 'rejected', by: 'pc' }), bad('approval missing raw JSON preview', 'item', { type: 'requested', pending: { ...approval, preview: { text: 'Run git status' } } }, 'invalid_item'))
  if (method === 'files.changes') cases.push(good('watch ready', 'item', { type: 'ready' }), good('changed paths', 'item', { type: 'changed', paths: [path + '\\README.md'] }), bad('changed paths must be an array', 'item', { type: 'changed', paths: path }, 'invalid_item'))
  if (method === 'sessions.prompt') cases.push(good('duplicate request acknowledged', 'result', { accepted: true, duplicate: true }))
  if (method === 'approvals.answer') cases.push(good('PC won approval race', 'result', { accepted: false, final: 'allowed-once', by: 'pc' }))
  if (method === 'questions.answer') cases.push(good('system already resolved question', 'result', { accepted: false, by: 'system' }))
  if (method === 'sessions.create') cases.push(good('new session by workspace path', 'params', { requestId: id, workspace: { path }, preset: 'review' }))
  if (method === 'fs.browse') cases.push(good('roots listing without a path', 'params', {}), good('roots listing result', 'result', { path: null, parent: null, entries: [{ name: path, kind: 'dir' }], truncated: false }))
  if (method === 'sessions.list') cases.push(good('future status falls back', 'result', { items: [{ ...session, status: 'future-status' }] }, { items: [{ ...session, status: 'unknown' }] }))
  // Filename keeps the exact method name; the suite label is lowercase because
  // the vector-file schema forbids uppercase in suite labels.
  write('rcp/methods/' + method.toLowerCase(), cases, methodNotes, 'rcp/methods/' + method)
}

const envelope = [
  { k: 'req', id: 1, m: 'ping', p: { t: at } },
  { k: 'req', id: 4294967295, m: 'host.status' },
  { k: 'res', id: 1, ok: true, r: { t: at, hostTime: at + 12 } },
  { k: 'res', id: 2, ok: false, e: { code: 'forbidden', message: 'Access denied.' } },
  { k: 'item', sid: 9, n: 0, d: { type: 'events', events: [event] } },
  { k: 'end', sid: 9, ok: true },
  { k: 'cancel', sid: 9 },
  { k: 'evt', e: 'host.shutdown', d: {} },
].map((value) => ({ name: 'valid ' + value.k + ('ok' in value ? ' ' + value.ok : '') + ('m' in value ? ' ' + value.m : ''), input: { value }, expect: value }))
for (const [name,value] of [['negative request id',{k:'req',id:-1,m:'ping'}],['u32 overflow',{k:'cancel',sid:4294967296}],['missing failure error',{k:'res',id:1,ok:false}],['null optional params',{k:'req',id:1,m:'ping',p:null}],['missing item data',{k:'item',sid:1,n:0}],['success must not include error',{k:'res',id:1,ok:true,e:{code:'conflict',message:'Conflict.'}}]]) envelope.push({name,input:{value},error:'invalid_request'})
write('rcp/envelope',envelope,'Decoded known fields are compared, allowing implementations to discard unknown optional fields. Optional null is invalid; absence stays absent on encode. Error envelope uses the current shared implementation shape; spec §3 inconsistency is tracked separately.')

const events = [
  { kind: 'session.created', sessionId }, { kind: 'session.status', sessionId, status: 'running' },
  { kind: 'turn.start' }, { kind: 'turn.end', status: 'completed' }, { kind: 'agent.error', message: 'Operation failed.', code: 'internal' },
  { kind: 'user.message', text: 'Review changes', source: 'user', requestId: id, attachments: [{ name: 'notes.txt', mime: 'text/plain' }] },
  { kind: 'assistant.message', text: 'Ready.', reasoning: 'Inspect first.', model },
  { kind: 'assistant.attempt', outcome: 'retried', text: 'Retrying after stream interruption.' },
  { kind: 'assistant.delta', index: 0, text: 'Ready', attempt: 'attempt-1' },
  { kind: 'tool.call', callId: 'call-1', tool: 'shell', title: 'Git status', args: { text: 'git status', bytes: 10, truncated: false } },
  { kind: 'tool.result', callId: 'call-1', status: 'ok', output: { text: 'clean', bytes: 5, truncated: false } },
  { kind: 'approval.asked', id, toolName: 'shell', risk: 'high' }, { kind: 'approval.decided', toolName: 'shell', callId: 'call-1', outcome: 'rejected' },
  { kind: 'question.asked', id, text: 'Which checks?' }, { kind: 'question.decided', id, outcome: 'answered', by: 'phone' },
  { kind: 'todo.updated', items: [{ text: 'Review', status: 'in_progress' }] }, { kind: 'notice', level: 'warn', text: 'Connection resumed.' },
  { kind: 'unknown', dshType: 'new-upstream-kind' },
].map((payload,index) => { const value={seq:index,at,...payload}; return {name:payload.kind,input:{value},expect:value} })
for (const [name,value,expected] of [
  ['unknown future event',{seq:20,at,kind:'future.event',detail:'retained'},{seq:20,at,kind:'unknown',dshType:'future.event',detail:'retained'}],
  ['unknown turn status',{seq:21,at,kind:'turn.end',status:'future'},{seq:21,at,kind:'turn.end',status:'unknown'}],
  ['unknown tool status',{seq:22,at,kind:'tool.result',callId:'call-1',status:'future',output:{text:'',bytes:0,truncated:false}},{seq:22,at,kind:'tool.result',callId:'call-1',status:'unknown',output:{text:'',bytes:0,truncated:false}}],
  ['unknown approval risk is conservative',{seq:23,at,kind:'approval.asked',id,toolName:'shell',risk:'future'},{seq:23,at,kind:'approval.asked',id,toolName:'shell',risk:'high'}],
  ['unknown source falls back',{seq:24,at,kind:'user.message',text:'hello',source:'future'},{seq:24,at,kind:'user.message',text:'hello',source:'other'}],
  ['unknown todo status',{seq:25,at,kind:'todo.updated',items:[{text:'Review',status:'future'}]},{seq:25,at,kind:'todo.updated',items:[{text:'Review',status:'unknown'}]}],
]) events.push({name,input:{value},expect:expected})
events.push({name:'known event cannot hide malformed required fields',input:{value:{seq:30,at,kind:'tool.call',callId:'call-1',tool:'shell',title:'Missing preview'}},error:'invalid_event'}, {name:'negative durable sequence',input:{value:{seq:-1,at,kind:'turn.start'}},error:'invalid_event'})
write('rcp/session-events',events,'Covers every current and normative event kind, including legacy compatibility and unknown fallbacks. Expected decoded payloads are authored explicitly; not observed decoder output.')

// Compact size recipe: consumers fill a request text with this many repetitions
// and optional ASCII padding. The exact JSON syntax overhead is 56 UTF-8 bytes.
const limits = [
  {name:'ASCII one byte below cap',input:{unit:'a',repeat:49095,padding:''},expect:{bytes:49151}},
  {name:'ASCII exactly at cap',input:{unit:'a',repeat:49096,padding:''},expect:{bytes:49152}},
  {name:'ASCII one byte over cap',input:{unit:'a',repeat:49097,padding:''},error:'too_large'},
  {name:'UTF8 two-byte characters exactly at cap',input:{unit:'é',repeat:24548,padding:''},expect:{bytes:49152}},
  {name:'UTF8 supplementary characters exactly at cap',input:{unit:'😀',repeat:12274,padding:''},expect:{bytes:49152}},
  {name:'UTF8 supplementary characters over cap',input:{unit:'😀',repeat:12274,padding:'a'},error:'too_large'},
]
write('rcp/limits',limits,'Recipe serializes exactly {"k":"req","id":1,"m":"sessions.prompt","p":{"text":"<fill>"}} with fill=unit repeated repeat times + padding. The 56-byte fixed syntax overhead and 49152-byte cap are manually derived; no implementation was executed to obtain expected sizes. This exercises envelope transport size, not sessions.prompt parameter validation.')

// b64u sample values for structural relay cases, derived from fixed byte
// sequences with a local encoder (no implementation or Node Buffer involved).
const B64U_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const toB64u = (bytes) => {
  let text = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null
    text += B64U_ALPHABET[b0 >> 2]
    text += B64U_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)]
    if (b1 === null) break
    text += B64U_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)]
    if (b2 === null) break
    text += B64U_ALPHABET[b2 & 63]
  }
  return text
}
const NONCE_B64U = toB64u(Array.from({ length: 32 }, (_, i) => i))
const TICKET_B64U = toB64u(Array.from({ length: 32 }, (_, i) => (i * 7 + 1) % 256))
const SIG_B64U = toB64u(Array.from({ length: 64 }, (_, i) => (i * 11 + 3) % 256))
const PUSH_CT_B64U = toB64u(Array.from({ length: 96 }, (_, i) => (i * 13 + 5) % 256))

// RLY/1 §6 data frames. input.hex is the exact frame bytes; expect carries the
// decoded header fields (peerId/payload as lowercase hex) or an error label
// naming the violated header invariant. Reserved bytes are always zero here.
const peerIdBytes = Array.from({ length: 16 }, (_, index) => index)
const bytesHex = (bytes) => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
const peerIdHex = bytesHex(peerIdBytes)
const frameHex = (version, type, channel, peerKind, payload) =>
  bytesHex([version, type, 0, 0, (channel >>> 24) & 255, (channel >>> 16) & 255, (channel >>> 8) & 255, channel & 255, peerKind, ...peerIdBytes, 0, 0, 0, ...payload])
const dataExpect = (channel, peerKind, payload) => ({ version: 1, type: 1, channel, peerKind, peerId: peerIdHex, payload: bytesHex(payload) })
const dataCases = [
  { name: 'host to device with payload', input: { hex: frameHex(1, 1, 42, 2, [0x70, 0x69, 0x6e, 0x67]) }, expect: dataExpect(42, 2, [0x70, 0x69, 0x6e, 0x67]) },
  { name: 'device to host empty payload', input: { hex: frameHex(1, 1, 1, 1, []) }, expect: dataExpect(1, 1, []) },
  { name: 'u32 channel boundary', input: { hex: frameHex(1, 1, 4294967295, 2, [255]) }, expect: dataExpect(4294967295, 2, [255]) },
  { name: 'header truncated', input: { hex: '00'.repeat(27) }, error: 'too_short' },
  { name: 'unsupported version byte', input: { hex: frameHex(2, 1, 42, 2, []) }, error: 'version' },
  { name: 'unsupported type byte', input: { hex: frameHex(1, 2, 42, 2, []) }, error: 'type' },
  { name: 'unknown peer kind', input: { hex: frameHex(1, 1, 42, 3, []) }, error: 'peer_kind' },
]
write('relay/data-frame', dataCases, 'input.hex is the exact frame; expect decodes version/type/channel/peerKind numerically and peerId/payload as lowercase hex, matching both language codecs. Error labels name the rejected header invariant. Reserved bytes are zero and never validated by the codecs; relay-level reserved-byte rejection lives above this layer.')

// RLY/1 §5 control frames. input.value is the exact frame JSON; expect echoes
// it because the TS zod schemas are passthrough. Error labels name the violated
// normative bound (rid ≤ 32, priority/ttl/status/kind sets, required fields).
const hostId = 'h_' + 'v'.repeat(31)
const deviceId = 'd_' + 'v'.repeat(31)
const peer = { id: deviceId, kind: 'device', name: 'Vector phone', online: true, lastSeenAt: at }
const challenge = { t: 'challenge', v: 1, nonce: NONCE_B64U, time: at }
const controlCases = [
  { name: 'challenge', input: { value: challenge }, expect: challenge },
  { name: 'ready with peers', input: { value: { t: 'ready', v: 1, id: hostId, peers: [peer] } }, expect: { t: 'ready', v: 1, id: hostId, peers: [peer] } },
  { name: 'ping', input: { value: { t: 'ping' } }, expect: { t: 'ping' } },
  { name: 'pong', input: { value: { t: 'pong' } }, expect: { t: 'pong' } },
  { name: 'presence online', input: { value: { t: 'presence', id: deviceId, kind: 'device', online: true, at } }, expect: { t: 'presence', id: deviceId, kind: 'device', online: true, at } },
  { name: 'enroll ticket request', input: { value: { t: 'enroll.ticket', rid: 'r1' } }, expect: { t: 'enroll.ticket', rid: 'r1' } },
  { name: 'enroll ticket granted', input: { value: { t: 'enroll.ticket.ok', rid: 'r1', ticket: TICKET_B64U, expiresAt: at + 600000 } }, expect: { t: 'enroll.ticket.ok', rid: 'r1', ticket: TICKET_B64U, expiresAt: at + 600000 } },
  { name: 'endpoint list request', input: { value: { t: 'endpoint.list', rid: 'r2' } }, expect: { t: 'endpoint.list', rid: 'r2' } },
  { name: 'endpoint list reply', input: { value: { t: 'endpoint.list.ok', rid: 'r2', devices: [peer] } }, expect: { t: 'endpoint.list.ok', rid: 'r2', devices: [peer] } },
  { name: 'endpoint revoke request', input: { value: { t: 'endpoint.revoke', rid: 'r3', id: deviceId } }, expect: { t: 'endpoint.revoke', rid: 'r3', id: deviceId } },
  { name: 'push with explicit delivery fields', input: { value: { t: 'push', rid: 'r4', to: [deviceId], ct: PUSH_CT_B64U, priority: 'high', ttl: 3600 } }, expect: { t: 'push', rid: 'r4', to: [deviceId], ct: PUSH_CT_B64U, priority: 'high', ttl: 3600 } },
  { name: 'push result', input: { value: { t: 'push.result', rid: 'r4', results: [{ id: deviceId, status: 'sent' }] } }, expect: { t: 'push.result', rid: 'r4', results: [{ id: deviceId, status: 'sent' }] } },
  { name: 'push token update', input: { value: { t: 'push.token', rid: 'r5', token: 'fcm-token-vector', hostOffline: true } }, expect: { t: 'push.token', rid: 'r5', token: 'fcm-token-vector', hostOffline: true } },
  { name: 'bye with reason', input: { value: { t: 'bye', reason: 'shutdown' } }, expect: { t: 'bye', reason: 'shutdown' } },
  { name: 'ok reply', input: { value: { t: 'ok', rid: 'r5' } }, expect: { t: 'ok', rid: 'r5' } },
  { name: 'error reply', input: { value: { t: 'error', rid: 'r6', code: 'not_linked', message: 'Destination is not linked.', ref: 'r6' } }, expect: { t: 'error', rid: 'r6', code: 'not_linked', message: 'Destination is not linked.', ref: 'r6' } },
  { name: 'unknown frame type', input: { value: { t: 'self-introduced' } }, error: 'unknown_type' },
  { name: 'challenge missing nonce', input: { value: { t: 'challenge', v: 1, time: at } }, error: 'missing_nonce' },
  { name: 'auth missing signature', input: { value: { t: 'auth', v: 1, kind: 'host', id: hostId } }, error: 'missing_sig' },
  { name: 'presence unknown kind', input: { value: { t: 'presence', id: deviceId, kind: 'router', online: true, at } }, error: 'bad_kind' },
  { name: 'push priority outside the set', input: { value: { t: 'push', rid: 'r7', to: [deviceId], ct: PUSH_CT_B64U, priority: 'urgent', ttl: 3600 } }, error: 'bad_priority' },
  { name: 'push ttl above one day', input: { value: { t: 'push', rid: 'r8', to: [deviceId], ct: PUSH_CT_B64U, priority: 'normal', ttl: 86401 } }, error: 'ttl_range' },
  { name: 'push result unknown status', input: { value: { t: 'push.result', rid: 'r9', results: [{ id: deviceId, status: 'maybe' }] } }, error: 'bad_status' },
  { name: 'rid above 32 characters', input: { value: { t: 'ok', rid: 'r'.repeat(33) } }, error: 'rid_too_long' },
]
write('relay/control-frames', controlCases, 'input.value is the exact control frame JSON. Expected decoded frames echo the authored fields; implementations may drop unknown optional fields. Priority and ttl are always authored explicitly because the TS schema injects defaults. Error labels name the violated normative bound from RLY/1 §5.')

// RLY/1 §3 connection handshake (structural). Signature validity over the
// challenge nonce is covered by crypto/relay-auth.json; these cases pin frame
// shapes both languages agree on. app is the version string both clients send.
const authCases = [
  { name: 'relay challenge', input: { value: challenge }, expect: challenge },
  { name: 'host auth with app version', input: { value: { t: 'auth', v: 1, kind: 'host', id: hostId, sig: SIG_B64U, app: '1.0.0' } }, expect: { t: 'auth', v: 1, kind: 'host', id: hostId, sig: SIG_B64U, app: '1.0.0' } },
  { name: 'device auth without app', input: { value: { t: 'auth', v: 1, kind: 'device', id: deviceId, sig: SIG_B64U } }, expect: { t: 'auth', v: 1, kind: 'device', id: deviceId, sig: SIG_B64U } },
  { name: 'auth missing signature', input: { value: { t: 'auth', v: 1, kind: 'device', id: deviceId } }, error: 'missing_sig' },
  { name: 'auth unknown kind', input: { value: { t: 'auth', v: 1, kind: 'relay', id: hostId, sig: SIG_B64U } }, error: 'bad_kind' },
  { name: 'challenge wrong version', input: { value: { t: 'challenge', v: 2, nonce: NONCE_B64U, time: at } }, error: 'version' },
]
write('relay/auth', authCases, 'Structural handshake frame shapes from RLY/1 §3; both clients send app as a plain version string. Challenge-response signature validity is out of scope here and covered by crypto/relay-auth.json.')
