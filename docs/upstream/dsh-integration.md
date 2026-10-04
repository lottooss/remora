# dsh integration notes

Verified facts about DeepSeek Harness that Remora depends on. **Baseline: `@deepseek-ai/dsh@0.1.5-rc.3`, git tag `dsh-v0.1.5-rc.3` (commit `a4c74a91e0`).** File paths are relative to the upstream repository root; line numbers are at that tag. When you verify a fact against a newer version, add a row to [§9](#9-verification-log) rather than silently editing.

Get the source locally (sparse, read-only, git-ignored):

```sh
node scripts/fetch-upstream.mjs          # → .upstream/deepseek-harness at the tag in upstream.lock.json
```

## 1. Where to read first

| Topic | Upstream file |
|---|---|
| Architecture, events, turn flow, "where new behavior goes" | `docs/architecture.md` |
| Cordis in five ideas, waterfall semantics, loader `!!js` | `docs/cordis-primer.md` |
| Typert Remote API, gateway, strict vs SRC descriptors | `docs/api-gateway.md`, `packages/api/gateway/README.md` |
| Capability seams (Definition / Provider / Consumer) | `docs/capability-seams.md`, `docs/user/develop/practice/index.md` |
| Cookbooks: packages, tools, settings cards, Remote APIs | `docs/cookbook/*.md` |
| Profiles, `dsh plugin`, patch layer order, shutdown | `apps/cli/reference/README.md` |
| Repository conventions | `AGENTS.md` (root) |

## 2. Profiles, bundles, installation

- A profile lives at `$DSH_HOME/profiles/<name>` (`$DSH_HOME` defaults to `~/.dsh`). Its `package.json` field `dsh.profile.bundles` lists bundles; layers apply in order: bundles → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays. Source: `apps/cli/reference/README.md` §Profiles, `docs/architecture.md` §Profiles and bundles.
- `dsh --profile <new> --from-default-profile web` creates a custom profile from the shipped `web` template (custom profiles default to live patch reload).
- `dsh plugin --profile <name> <pnpm args>` runs pnpm in the profile directory. Relative paths are anchored to the invoking directory (`add ./packages/host` installs a local checkout without build allowances). After every run, dependencies whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` join `dsh.profile.bundles`. Bundle membership changes need a restart; patch edits hot-reload in live profiles. Source: `apps/cli/reference/README.md` §Plugin management.
- `--dump-config` prints the composed tree with the file that supplied each row.
- The `desktop` profile is reserved for Electron; the CLI refuses plugin management for it.

**Bundle manifest example:** `packages/bundle/web-app/package.json` (`dsh.bundle.patch`, exports `./cordis.patch.yml`, peer dependency on `@deepseek-ai/cordis`).

**Patch row syntax** (`packages/bundle/web-app/cordis.patch.yml`):

```yaml
- id: session-query-sqlite       # replace an existing row's whole config
  config: { path: ':memory:', openAt: never }
- insert:                         # add rows
    - id: remora
      name: '@remora/host'
      config: { … }
```

`!!js` expressions are allowed under `config` and `disabled` only.

## 3. Plugin anatomy

Minimal pattern (see `packages/host/frontend-static/src/index.ts`):

```ts
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'remora'
export const inject = ['typertGateway', 'sessions', 'agents']
export interface Config { relayUrl: string }
export const Config: z<Config> = z.object({ relayUrl: z.string().required() })
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => { /* start */ return () => { /* dispose */ } }, 'remora: relay link')
}
```

Conventions from upstream `AGENTS.md` that apply inside the dsh process: ESM only; `@deepseek-ai/cordis` is a peer dependency; every registration is an effect (`ctx.effect()` / `ctx.on()` return disposers); waterfall listeners must call `next()` to delegate; misconfiguration fails loudly at load; defaults come from an explicit `resolve(config)` step; opaque ids are branded; empty `catch` blocks name what they swallow.

## 4. Remote API reachable in-process

`ctx.typertGateway` (Host service from `@deepseek-ai/dsh-api-gateway`):

- `invoke(request: InvokeRemoteRequest): Promise<unknown>` — `packages/api/gateway/src/index.ts:298`
- `stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>` — `:321`
- `InvokeRemoteRequest { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }` — `packages/api/gateway/src/types.ts:10`
- Validation: `args` must match the descriptor's named fields exactly; wire values are codec-validated; `agent`/`session` lookups use the Session Controller's policy (reuse live Agent, auto-resume cold sessions, dedupe concurrent resumes, reject subagent-owned identities). Business `RemoteError`s keep their codes (`session/not-found`, `session/agent-busy`); dispatch failures are `gateway/*`.

### Session Controller (`namespace: 'session'`, service `ctx.sessionController`) — `packages/api/session-controller/src/index.ts`

| Endpoint | Line | Notes |
|---|---|---|
| `list(request, signal)` | 222 | stored headers + projection cache; never activates an Agent |
| `search(request, signal)` | 233 | literal content query |
| `create(request)` | 243 | create or idempotently adopt; requested identity, location, preset |
| `selectModel(request)` | 253 | resumes the session |
| `modelCatalog()` | 262 | provider-grouped models + default |
| `canOpenWorkspacePath()`, `openWorkspacePath(request, signal)` | ~270, 292 | native desktop opener (not used by Remora) |
| `rename(request)` | 324 | |
| `fork(request)` | 334 | completed-turn prefix into a new session |
| `prompt(request, signal)` | 345 | content must have text or attachment; **`requestId` retries return the original acceptance** |
| `attachment(request)` | 356 | image bytes proven reachable from the log |
| `updateQueue(request)` | 366 | live Agent only |
| `cancel(request)` | 376 | cancels the active turn, keeps the inbox |
| `page(request, signal)` | 387 | cold-safe, message-aligned history page |
| `follow(request, signal)` (stream) | 399 | opening snapshot → gap-free durable frames → optional cursorless assistant frames; resumes from "last committed sequence already held by the caller" |
| `control(signal)` (stream) | 409 | complete live-control baseline then replacement frames (queue, jobs, projection) |

Client-safe request/response types: `@deepseek-ai/dsh-api-session-controller/types`. Follow semantics in `packages/api/session-controller/README.md` (journal stream, `loadOlder` 50-message pages, settlement of live attempts, reset on continuity failure).

The controller also emits Host events `api-session/added|removed|status|error|activity` (`index.ts` ~150–170) from `agent/status` (`{ agent, status }`), `agent/error` (`{ agent, error }`), and `session/event` (`(session, event)`).

### Workspace Controller (`namespace: 'workspace'`, service `workspaceController`) — `packages/api/workspace-controller/src/index.ts`

`create(request)` :57 (create or idempotently resolve over an existing directory) · `rename` :67 · `delete` :77 (retains files and sessions) · `insertBefore` :87 · `insertSessionBefore` :97 · `archiveSession` :107 · `follow(signal)` stream :117 (baseline + ordered increments).

### Directory picker (`namespace: 'directoryPicker'`, service `directoryPickerController`) — `packages/api/workspace-controller/src/directory-picker.ts`

`pick(signal)` :54 (native OS chooser — not usable remotely) · `list(path | undefined, signal)` :71 (absent path lists the home directory) · `createDirectory(path, name)` :87.

### Workspace files (`namespace: 'workspaceFiles'`) — `packages/api/workspace-files`

`stat`, `read` (line pages, `maxLines` cap), `readBytes`, `readAll` (`maxFileBytes` cap), `readRelated`, `list` (workspace-scoped), `changes` (stream, `src/index.ts:364`). Every method takes the session id on the wire. **Reads are not confined to the workspace** — Remora's Policy Guard must confine them.

## 5. Approvals and questions

- Event `approval/request` (waterfall, Agent-scoped): `packages/interaction/user-approval/src/types.ts`. Payload `ApprovalRequestEvent { agent; toolName; callId?; reason?; signal? }`; result `ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`.
- `ApprovalService.decide()` (`packages/interaction/user-approval/src/index.ts` ~255–305): policy `never` rejects before dispatch; waterfall terminal default is `unavailable`; throwing or non-vocabulary answers normalize to `unavailable`; the waterfall races the request signal (abort → `cancelled`, late answers discarded). Audit events `approval/asked` / `approval/decided` are log-only.
- Event `user-questions/request` (waterfall, Agent-scoped): `packages/interaction/user-questions/src/types.ts`. Payload `{ questions: AskUserQuestionItem[]; agent?; signal? }` → `AskUserQuestionAnswer { answers: { id; selected[]; custom? }[] }`. Terminal default rejects `NO_PROVIDER`. `intent: { kind: 'plan-review', approve }` marks plan reviews. Delegated (subagent-owned) callers cannot ask.
- Web forwarding: `packages/api/remotes/src/remote-events.ts` (`API_REMOTE_FORWARDED_EVENTS`, both marked `mode: 'waterfall'`) and `packages/api/remotes/src/index.ts` (`remoteEventSource` registers one listener set **per client stream**; `forwardWaterfall` pushes a pending dispatch to that client; the client answers or delegates to `next()`; with no queue it calls `next()`).
- Cordis waterfall: listeners receive `(...args, next)`; `next()` takes no arguments; `prepend: true` orders a listener before ordinary registrations (`docs/cordis-primer.md`).

## 6. Browser GUI security (what Remora must not weaken)

`packages/client/connection/README.md` §Browser authentication: per-process launch token → signed, host-bound, `HttpOnly`, `SameSite=Strict` cookie (30 days); `/api` and `/api/remote.mux` require it; Host must be loopback or a `--trusted-host`; Origin must match; `sec-fetch-site: cross-site` refused; `--host 0.0.0.0` unsupported. The cookie signing secret is the `client-connection/browser-session` record in `ctx.credentials`.

`packages/bundle/web-app/README.md`: flags `--port`, `--trusted-host`, `--no-open`; the startup line `dsh web: <url with token>`; `DSH_WEB_URL` is exposed to agent shell commands.

## 7. Other seams used

| Need | Seam | Source |
|---|---|---|
| Secrets (host keys, per-device PSK/push key, enroll secret) | `ctx.credentials` (records + key names) | `packages/credentials/credentials/README.md` |
| Non-secret state (device registry, prefs) | `ctx.storage.domain` | `dsh-storage-domain` README |
| Live agent status, errors | events `agent/status`, `agent/error` | session-controller `index.ts` ~150 |
| Durable session facts | `session/event` `(session, event)`; `ctx.sessions.get(id)?.snapshotEvents()` | `docs/architecture.md` §Session log; session-controller `inspect()` |
| Local HTTP routes behind browser auth | `ctx.connection` exact Fetch routes under `/api` | client-connection README §Use this package (⟂ P0-S1) |
| Trailing-slash alias for `/api/remora/` | `ctx.webServer.register` exact route (exact table wins over prefix), guarded with `connection.requestRejection` for parity with `/api` | `host/webserver/src/index.ts` (`register`, `match`); `client-connection/src/rpc-host.ts` (`requestRejection`) |
| Logging | `ctx.logger` | Cordis |
| Mock LLM for e2e | `@deepseek-ai/dsh-llm-mock-server` (OpenAI-compatible HTTP/SSE fault server) + `DEEPSEEK_BASE_URL` | npm |

## 8. Open questions (owned by spikes)

| Id | Question | Spike | Status / Answer |
|---|---|---|---|
| Q1 | Can an out-of-tree plugin in an npm-installed dsh call `typertGateway.invoke/stream` with strict descriptors for `session/*`, `workspace/*`, `directoryPicker/*`, `workspaceFiles/*`? | P0-S1 | **Yes.** Verified in P0-S1; strict descriptors validate and execute. |
| Q2 | Exact `SessionFollowRequest` fields (resume cursor, live-frame opt-in) and `SessionFollowFrame` variants; record fixtures | P0-S1 | **Documented & Recorded.** Fixtures recorded in `packages/host/test/fixtures/dsh-0.1.5-rc.3/`. Resume cursor filtered client-side. |
| Q3 | Can an out-of-tree plugin register exact `/api/remora/*` Fetch routes that inherit browser authentication? | P0-S1 | **Yes.** `ctx.connection.fetch.register` (exact routes under `/api`) inherits the browser-auth cookie, Host/Origin fence, and `sec-fetch-site: cross-site` refusal (private impl `registerFetchRoute`). Used by P2-H1 for `/api/remora` and its actions. |
| Q4 | `ctx.credentials` record API and `ctx.storage.domain` API for an out-of-tree owner | P0-S1 | **Yes.** Namespaced records `${scope}/${id}` work cleanly without private imports. |
| Q5 | Do root-context `prepend` listeners receive Agent-scoped waterfall dispatches first? | P0-S2 | **Yes.** Verified in P0-S2; root-context listeners registered with `prepend: true` fire before child/Agent-scoped listeners. |
| Q6 | How is a forwarded waterfall withdrawn from a browser when resolved elsewhere? Which withdrawal option works? | P0-S2 | **Derived `AbortSignal` on `next()`.** Forwarded request abort signal cancels browser UI prompt without aborting the parent turn. |
| Q7 | Best way to fetch tool-call arguments by `callId` for previews (live `Session` vs `sessionController.inspect`) | P0-S2 | **Live `Session` state.** In-memory Session interaction state contains live tool arguments before commit. |
| Q8 | Permission-preset change API for phone-initiated changes (gated `high`) | P3-H2 | Owned by P3-H2 |
| Q9 | Is `koffi` resolvable from an out-of-tree bundle for `SetThreadExecutionState`, or is a helper process better? | P0-S6 | **In-process `koffi` is recommended.** Zero IPC overhead, and Windows automatically resets execution state on process termination. |
| Q10 | Install form: does `dsh plugin add ./packages/host` (linked checkout) load a second copy of the peer dependencies `@deepseek-ai/cordis` / `@deepseek-ai/schemastery` from the Remora repo's `node_modules`, and does that break Loader/schema identity? Is a packed tarball (`pnpm -F @remora/host pack`) the safer install form? | P0-S1 | **Packed tarball is the recommended install form.** Isolates peer dependencies and prevents duplicate loader instances. |

## 9. Verification log

### 9.1 Real-dsh fixture recording procedure (P7-H10)

The fixtures under `packages/host/test/fixtures/dsh-0.1.5-rc.3/` are recorded
bytes, not hand-written shapes. They were produced on the worker's machine
against the **pinned** `@deepseek-ai/dsh@0.1.5-rc.3` with a scripted mock LLM,
inside a temporary `DSH_HOME` (the owner's `~/.dsh` is never touched); CI
replays the committed bytes. The recording tooling is a throwaway bundle under
`.scratch/` (never imported by production code); this section is the procedure.

Recording setup (one driver script, modeled on the P0-S2 spike):

1. Install the pinned dsh and the mock server into a scratch prefix:
   `npm install --no-fund --no-audit @deepseek-ai/dsh@0.1.5-rc.3 @deepseek-ai/dsh-llm-mock-server@0.1.5-rc.3`.
2. Create a temporary home (`mkdtemp`) and initialize the profile from the web
   template: `DSH_HOME=<temp> dsh --profile remora-rec --from-default-profile web --dump-config`.
3. Add the recorder bundle to that profile:
   `DSH_HOME=<temp> dsh plugin --profile remora-rec add <recorder-dir>`.
4. Start the scripted LLM:
   `startMockLlmServer({ sequence: ['tool_call_success', 'success'], toolName, toolArguments, apiKey })`
   from `@deepseek-ai/dsh-llm-mock-server` (no published bin).
5. Boot real dsh against it:
   `DSH_HOME=<temp> DEEPSEEK_BASE_URL=<mock>/v1 DEEPSEEK_API_KEY=<key> dsh --profile remora-rec --no-open --port 7731`,
   plus `P7H10_OUT` (output dir) and `P7H10_SCENARIO` (`tool-approval` | `question`).
6. The recorder plugin drives the scenario in-process through the typert
   gateway (§4): create a temp workspace, create a session, open a
   `session/follow` stream, then `session/prompt` so the mock LLM emits the
   scripted tool call, and collect frames until `turn/end`.

Two scenarios were recorded:

- **tool-approval** — the mock calls a registered `bash` tool with
  `{"command":"echo remora-p7-h10 && uptime"}`. The recorder returns
  `{ kind: 'ask', reason }` from a prepend `tools/pre-execute` hook for the
  tool (the same seam P0-S2 verified), so dsh's **real** approval service
  appends durable `approval/asked` / `approval/decided` events and dispatches
  the real `approval/request` waterfall. The recorder answers `allowed-once`
  (ADR-0008 answer-first, derived-`AbortSignal` withdrawal of the PC chain) so
  the tool executes and a real `tool/result` follows.
- **question** — the mock calls the real `ask_user_question` tool, which fires
  the real `user-questions/request` waterfall; the recorder answers the first
  option of the scripted question.

Recorded artifacts per scenario: `follow-<scenario>.jsonl` (the durable
`session/follow` frames, including `tool/call`, `approval/asked`,
`approval/decided`, `tool/result`), `approval-request.json` /
`question-request.json` (the raw waterfall payload, agent identity reduced to
`{ id }`), `recorder-log.jsonl`, and `report.json`. The committed fixtures are
exactly these files.

Verified fact reinforced by the recording: `tool/call` data is
`{ turn, step, callId, name, arguments }` where `arguments` is the raw **JSON
string** the model produced — any preview logic must parse it.

| Date | dsh version | Verified by | Scope | Result |
|---|---|---|---|---|
| 2026-09-24 | 0.1.5-rc.3 (source reading) | Integrator | §2–§7 | as documented; runtime behavior pending P0 spikes |
| 2026-09-24 | 0.1.5-rc.3 | Host role (P0-S1) | Q1–Q4, Q10 | Verified: in-process gateway calls, follow streams, credentials, storage, and packed bundle installation |
| 2026-09-24 | 0.1.5-rc.3 | Host role (P0-S2) | Q5–Q7 | Verified: waterfall prepend ordering, AbortSignal withdrawal, and Session tool-call argument inspection |
| 2026-09-24 | Windows 11 / Node v24 | Host role (P0-S6) | Q9 | Verified: SetThreadExecutionState via in-process koffi & non-elevated logon autostart |
| 2026-09-25 | 0.1.5-rc.3 (source reading) | Host role (P2-H1) | §7 fetch/webserver seams re-read for the management routes | as documented; `fetch.register` exact routes inherit the `/api` fence, `webServer.register` exact matches beat prefix matches |
| 2026-10-04 | 0.1.5-rc.3 | Host role (P7-H10) | §9.1 fixture recording (Windows 11 / Node v24, temp DSH_HOME) | Verified: real bash-tool approval and real ask_user_question flows recorded with the mock LLM; durable events match §5 event types; `tool/call.arguments` confirmed to be a JSON string |


