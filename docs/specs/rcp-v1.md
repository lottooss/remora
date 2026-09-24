# RCP/1 — Remora Control Protocol

Status: **v1-draft** (frozen by P0-A1). Implementations: `@remora/protocol` (TypeScript types + zod schemas), `packages/host/src/rcp` (server), `@remora/testkit` (TypeScript client), `:core:protocol` + `:core:transport` (Kotlin client).

RCP is the only language the phone speaks. It is deliberately smaller and more stable than dsh's internal Remote API; the host's DshAdapter translates ([blueprint §8.4](../blueprint.md#84-dshadapter-how-remora-reaches-dsh)). Every RCP message travels as exactly one SC/1 transport record ([Crypto/1 §6](crypto-v1.md#6-secure-channel-sc1)).

## 1. Conventions

- Encoding: UTF-8 JSON, one message per record, **≤ 49,152 bytes serialized**. Senders MUST split lists across items or pages to stay below the limit; receivers MUST reject larger messages with `too_large`.
- Types below are normative TypeScript notation. Optional fields may be absent (never `null` unless the type says `| null`). Timestamps are integer milliseconds since the Unix epoch. `Seq` is dsh's durable event sequence (non-negative integer < 2^53).
- Unknown fields MUST be ignored. Unknown enum values MUST decode to an explicit fallback (`'unknown'` or the documented default), never fail the whole message.
- Ids: `HostId = "h_…"`, `DeviceId = "d_…"`, `SessionId`/`WorkspaceId` are opaque dsh strings, `Uuid` is a lowercase UUIDv4.
- Paths on the wire are absolute host paths in the host's native form (`C:\Users\…` on Windows). The phone never constructs paths except by joining a returned directory path with a returned entry name using the separator from `hello.host.pathSeparator`.

## 2. Envelope

```ts
type Message =
  | { k: 'req';   id: number; m: string; p?: object }               // request (either direction)
  | { k: 'res';   id: number; ok: true;  r?: object }               // success
  | { k: 'res';   id: number; ok: false; e: RcpError }              // failure
  | { k: 'item';  sid: number; n: number; d: object }               // stream item, n = 0,1,2,… per stream
  | { k: 'end';   sid: number; ok: boolean; e?: RcpError }          // stream closed by the server
  | { k: 'cancel'; sid: number }                                     // stream cancelled by the client
  | { k: 'evt';   e: string; d: object }                            // unsolicited notification
```

- `id` is a u32 chosen by the requester, unique among its own in-flight requests. Each direction has its own id space.
- A stream method's `res` returns `{ sid }`; items follow. The server allocates `sid` (u32, unique per channel). Either side ends a stream (`end` / `cancel`); `end` after `cancel` is optional.
- Requests time out client-side after 30 s (unary) unless stated; timeouts do not imply failure on the host — use idempotency keys and re-query.
- In v1 only the device opens streams. Host-initiated requests: `pair.complete`. Host events: `pair.rejected`, `host.shutdown`.

## 3. Errors

```ts
interface RcpError {
  code: ErrorCode
  message: string            // English, for logs; never contains secrets or payload excerpts
  retryable: boolean
  details?: { dsh?: string; field?: string; retryAfterMs?: number; by?: 'phone' | 'pc' | 'system' }
}
type ErrorCode =
  | 'bad_request' | 'unknown_method' | 'version_unsupported' | 'too_large'
  | 'not_found' | 'forbidden' | 'signature_required' | 'signature_invalid'
  | 'conflict' | 'already_resolved' | 'busy' | 'unavailable'
  | 'rate_limited' | 'timeout' | 'cancelled' | 'internal'
```

dsh `RemoteError` codes are mapped by the adapter (e.g. `session/not-found` → `not_found`, `session/agent-busy` → `busy`, `gateway/cancelled` → `cancelled`, unclassified → `internal`) with the original in `details.dsh`.

## 4. Session start

### `hello` (must be the first request on a channel)

```ts
p: { rcp: number[]; app: { name: 'remora-android' | 'remora-testkit'; version: string; build?: number } }
r: {
  rcp: 1
  host: { id: HostId; name: string; os: 'win32' | 'darwin' | 'linux'; pathSeparator: '\\' | '/';
          versions: { remora: string; dsh: string } }
  features: Feature[]                  // 'sessions' | 'interaction' | 'workspaces' | 'files' | 'diffs.git' | 'notify' | 'models'
  roots: string[]                      // canonical allowlisted roots (may be empty)
  policy: { approvalBiometric: 'high' | 'all' | 'never'; allowRemoteSessionStart: boolean }
  limits: { maxMessageBytes: number; maxStreams: number }
  time: number                         // host clock, for approval issuedAt
}
```

### `ping`

`p: { t: number }` → `r: { t: number; hostTime: number }`.

### `host.status`

`r: { uptimeMs: number; agentsRunning: number; keepAwake: boolean; dsh: { version: string; profile: string } }`.

## 5. Sessions

```ts
interface SessionSummary {
  id: SessionId
  title: string | null
  workspace: { id: WorkspaceId | null; path: string | null; title: string | null }
  status: 'idle' | 'running' | 'error' | 'unknown'
  updatedAt: number
  model?: ModelRef
  parentId?: SessionId
  archived?: boolean
}
interface ModelRef { provider: string; model: string; reasoningEffort?: string }
interface Preview { text: string; bytes: number; truncated: boolean }

type SessionEvent = { seq: Seq; at: number } & (
  | { kind: 'user.message'; text: string; source: 'user' | 'agent' | 'system' | 'other'; requestId?: string; attachments?: { name: string; mime: string }[] }
  | { kind: 'assistant.message'; text: string; reasoning?: string; model?: ModelRef }
  | { kind: 'assistant.attempt'; outcome: 'failed' | 'retried' | 'cancelled' | 'stream-error' | 'unknown'; text?: string }
  | { kind: 'tool.call'; callId: string; tool: string; title: string; args: Preview }
  | { kind: 'tool.result'; callId: string; status: 'ok' | 'error' | 'denied' | 'cancelled' | 'timeout' | 'unknown'; output: Preview }
  | { kind: 'turn.start' }
  | { kind: 'turn.end'; status: 'completed' | 'cancelled' | 'error' | 'interrupted' | 'unknown'; error?: string }
  | { kind: 'approval.decided'; toolName: string; callId?: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { kind: 'todo.updated'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' | 'unknown' }[] }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'unknown'; dshType: string }
)
```

Truncation: `tool.call.args` ≤ 2 KiB of text; `tool.result.output` = first 2 KiB + `…` + last 1 KiB; `assistant.message.text` ≤ 32 KiB (longer texts are split: the item carries the first 32 KiB and `sessions.eventText` returns the rest).

| Method | Kind | Params → Result |
|---|---|---|
| `sessions.list` | unary | `{ cursor?: string; limit?: 1..100; includeArchived?: boolean }` → `{ items: SessionSummary[]; next?: string }` |
| `sessions.search` | unary | `{ query: string (1..200) }` → `{ results: { sessionId; title: string \| null; snippet: string; at: number }[] }` |
| `sessions.follow` | stream | `{ sessionId; afterSeq?: Seq; live?: boolean (default true) }` → items `FollowItem` |
| `sessions.page` | unary | `{ sessionId; beforeSeq: Seq; limit?: 1..100 }` → `{ events: SessionEvent[]; hasOlder: boolean }` |
| `sessions.eventText` | unary | `{ sessionId; seq: Seq; offset: number; limit?: ≤ 32768 }` → `{ text: string; offset: number; eof: boolean }` (UTF-8 byte offsets, aligned to characters) |
| `sessions.toolOutput` | unary | `{ sessionId; callId: string; offset: number; limit?: ≤ 32768 }` → `{ text: string; offset: number; total: number; eof: boolean }` |
| `sessions.prompt` | unary, mutating | `{ sessionId; requestId: Uuid; text: string (1..32768); delivery: 'queue' \| 'steer' }` → `{ accepted: true; duplicate: boolean }` |
| `sessions.cancel` | unary, mutating | `{ sessionId; requestId: Uuid }` → `{ requested: true }` |
| `sessions.queue.update` | unary, mutating | `{ sessionId; itemId: string; action: 'edit' \| 'remove' \| 'steer'; text?: string; requestId: Uuid }` → `{ ok: true }` |
| `sessions.create` | unary, mutating, guarded | `{ requestId: Uuid; workspace: { id: WorkspaceId } \| { path: string }; model?: ModelRef; preset?: string }` → `{ sessionId; workspaceId }` |
| `sessions.rename` | unary, mutating | `{ sessionId; title: string (1..120); requestId: Uuid }` → `{ title: string }` |
| `sessions.selectModel` | unary, mutating | `{ sessionId; model: ModelRef; requestId: Uuid }` → `{ model: ModelRef }` |
| `sessions.control` | stream | `{}` → items `ControlItem` |
| `models.catalog` | unary | `{}` → `{ providers: { id; name; models: { id; name; reasoningEfforts?: string[] }[] }[]; default?: ModelRef }` |

```ts
type FollowItem =
  | { type: 'snapshot'; session: SessionSummary; events: SessionEvent[]; hasOlder: boolean }  // newest events that fit, ascending
  | { type: 'events'; events: SessionEvent[] }        // ascending, contiguous with everything delivered before
  | { type: 'live.start'; attempt: string; afterSeq: Seq }
  | { type: 'live.delta'; attempt: string; index: number; text?: string; reasoning?: string }   // coalesced; index strictly increasing
  | { type: 'live.end'; attempt: string; outcome: 'settled' | 'abandoned' }
  | { type: 'reset'; reason: 'cursor_unavailable' | 'session_replaced' }   // discard cached events; a snapshot follows

type ControlItem =
  | { type: 'baseline'; sessions: ControlState[] }
  | { type: 'update'; session: ControlState }
  | { type: 'removed'; sessionId: SessionId }
interface ControlState { sessionId: SessionId; running: boolean; queue: { itemId: string; text: string; delivery: 'queue' | 'steer' }[]; jobs: { id: string; title: string; state: string }[] }
```

**Follow semantics.** Without `afterSeq`: `snapshot` first. With `afterSeq` the host resumes with `events` whose `seq > afterSeq`; if it cannot, it sends `reset` then `snapshot`. Durable events are never dropped or reordered. Live frames are best effort and superseded by the settling `assistant.message`/`assistant.attempt`; a client that misses `live.*` frames still converges.

## 6. Workspaces and new sessions

```ts
interface Workspace { id: WorkspaceId; title: string; path: string; remoteAllowed: boolean }   // remoteAllowed = inside a root
```

| Method | Kind | Params → Result |
|---|---|---|
| `workspaces.follow` | stream | `{}` → items `{ type: 'baseline'; workspaces: Workspace[] }` · `{ type: 'upsert'; workspace: Workspace }` · `{ type: 'removed'; id: WorkspaceId }` |
| `workspaces.create` | unary, mutating, guarded | `{ path: string; requestId: Uuid }` → `{ workspace: Workspace; created: boolean }` |
| `fs.browse` | unary, guarded | `{ path?: string }` → `{ path: string \| null; parent: string \| null; entries: { name: string; kind: 'dir' \| 'file' \| 'link' }[]; truncated: boolean }` — no `path` lists the roots |
| `fs.mkdir` | unary, mutating, guarded | `{ parent: string; name: string (single segment); requestId: Uuid }` → `{ path: string }` |

`sessions.create` with `{ path }` implies `workspaces.create`. Guard: every path must canonicalize inside `roots`; `allowRemoteSessionStart` must be true; an existing workspace outside the roots may be used with `{ id }` only if it already exists (created at the PC).

## 7. Pairing and devices

| Message | Direction | Payload |
|---|---|---|
| `pair.complete` (req) | host → device | `{ devicePsk: b64u; pushKey: b64u; host: { id; name; os; versions } }` → device replies `{ stored: true }` only after persisting |
| `pair.rejected` (evt) | host → device | `{ reason: 'rejected' \| 'timeout' }` |
| `devices.self` (req) | device → host | `{}` → `{ id: DeviceId; name: string; pairedAt: number; approvalKey: { hardwareBacked: boolean \| null } }` |
| `devices.unpair` (req) | device → host | `{ requestId: Uuid }` → `{ ok: true }` then the host closes the channel |
| `devices.rotateApprovalKey` (req) | device → host | `{ approvalPub: b64u; requestId: Uuid }` → `{ status: 'pending_pc_confirmation' }`; the new key is active after PC confirmation |

Pairing channels (`purpose = "pair"`) accept only `hello`, `ping`, and the pairing messages; everything else is `forbidden`.

## 8. Interaction (approvals and questions)

```ts
type Pending = PendingApproval | PendingQuestion
interface PendingApproval {
  kind: 'approval'; id: Uuid; sessionId: SessionId; sessionTitle: string | null
  toolName: string; callId?: string; reason?: string
  preview: { text: string; json: string }          // what the user approves; json is a raw JSON string
  argsDigest: string                               // Crypto/1 §7
  risk: 'normal' | 'high'; requiresSignature: boolean
  createdAt: number; expiresAt: number
}
interface PendingQuestion {
  kind: 'question'; id: Uuid; sessionId: SessionId; sessionTitle: string | null
  questions: { id: string; question: string; detail?: string; header?: string
               options?: { label: string; description?: string }[]; multiSelect?: boolean
               intent?: { kind: 'plan-review'; approve: string } }[]
  createdAt: number; expiresAt: number
}
```

| Method | Kind | Params → Result |
|---|---|---|
| `interaction.follow` | stream | `{}` → items `{ type: 'baseline'; pending: Pending[] }` · `{ type: 'requested'; pending: Pending }` · `{ type: 'resolved'; id: Uuid; outcome: string; by: 'phone' \| 'pc' \| 'system'; deviceId?: DeviceId }` |
| `approvals.answer` | unary, mutating | `{ id: Uuid; outcome: 'allowed-once' \| 'rejected'; argsDigest: string; issuedAt: number; sig?: b64u }` → `{ accepted: boolean; final: 'allowed-once' \| 'rejected' \| 'cancelled' \| 'unavailable'; by: 'phone' \| 'pc' \| 'system' }` |
| `questions.answer` | unary, mutating | `{ id: Uuid; answers: { id: string; selected: string[]; custom?: string }[] }` → `{ accepted: boolean; by: 'phone' \| 'pc' \| 'system' }` |

Rules: `accepted: false` with the winning `by` when the item was already resolved (not an error). `requiresSignature` answers without a valid `sig` fail with `signature_required` / `signature_invalid` and the pending item stays open. An `approvalId` accepts at most one answer.

## 9. Files and diffs

| Method | Kind | Params → Result |
|---|---|---|
| `files.list` | unary, guarded | `{ sessionId; path: string }` → `{ path; entries: { name; kind: 'dir' \| 'file' \| 'link'; bytes?: number }[]; truncated: boolean }` |
| `files.stat` | unary, guarded | `{ sessionId; path }` → `{ path; bytes?: number; version: string }` |
| `files.read` | unary, guarded | `{ sessionId; path; offset?: number (1-based line); limit?: 1..400 }` → `{ path; version; offset; text; lines: number; eof: boolean; bytes?: number }` |
| `files.changes` | stream, guarded | `{ sessionId }` → items `{ type: 'ready' }` · `{ type: 'changed'; paths: string[] }` |
| `diffs.status` | unary, guarded | `{ sessionId }` → `{ source: 'git' \| 'session'; branch?: string; files: { path; status: 'M' \| 'A' \| 'D' \| 'R' \| 'C' \| 'U' \| '?'; oldPath?: string; adds?: number; dels?: number }[]; truncated: boolean }` |
| `diffs.file` | unary, guarded | `{ sessionId; path; fromHunk?: number }` → `{ path; binary: boolean; hunks: { header: string; lines: string[] }[]; nextHunk?: number }` |

Guard: paths must canonicalize inside the session's workspace root or a root. Binary files are reported, never streamed as text. `files.read` refuses files > 5 MiB with `too_large`.

## 10. Notifications

| Method | Kind | Params → Result |
|---|---|---|
| `notify.prefs.get` | unary | `{}` → `NotifyPrefs` |
| `notify.prefs.set` | unary, mutating | `NotifyPrefs` → `NotifyPrefs` |

`NotifyPrefs = { approval: boolean; question: boolean; turnDone: boolean; turnError: boolean }` (per device, stored on the host). The FCM token and the `hostOffline` preference go to the relay directly ([RLY/1 §5](relay-v1.md#5-control-frames-text-json)).

## 11. Method summary

| Method | Mutating | Idempotency | Guard / risk |
|---|---|---|---|
| `hello`, `ping`, `host.status` | no | — | paired device |
| `sessions.list/search/follow/page/eventText/toolOutput`, `sessions.control`, `models.catalog` | no | — | paired device |
| `sessions.prompt/cancel/queue.update/rename/selectModel` | yes | `requestId` (host cache 10 min + dsh `requestId` for prompts) | paired device |
| `sessions.create`, `workspaces.create`, `fs.mkdir` | yes | `requestId` | roots + `allowRemoteSessionStart` |
| `fs.browse`, `files.*`, `diffs.*` | no | — | roots / session root |
| `interaction.follow` | no | — | paired device |
| `approvals.answer` | yes | pending `id` single-use | signature when `requiresSignature` |
| `questions.answer` | yes | pending `id` single-use | paired device |
| `devices.*`, `notify.prefs.*` | mixed | `requestId` | self only; key rotation needs PC confirmation |

Per-device limits: 20 requests/s burst, 5 mutating requests/s, 10 concurrent streams; beyond → `rate_limited` with `retryAfterMs`.

## 12. Conformance vectors

`conformance/vectors/rcp/`: `envelope.json` (valid/invalid messages), `methods/*.json` (one file per method with request/response examples and invalid params), `session-events.json` (every `SessionEvent` kind incl. unknown-value fallbacks), `limits.json` (boundary sizes). The host's event mapper additionally uses recorded dsh fixtures in `packages/host/test/fixtures/`.
