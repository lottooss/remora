# SWARM.md — finishing Remora with an agent swarm

This is the playbook for completing Remora with a swarm of coding agents (e.g. GLM 5.3 Flash). Every swarm agent reads this file first, then [AGENTS.md](../AGENTS.md), then its task packet. The task packets are in [`docs/tasks/P7-*.md`](tasks/README.md), one GitHub issue per packet, milestone **P7 · Remediation & Real Integration**.

## 0. Why this phase exists (read this, it is not optional)

Phases P2–P6 were closed as "done" but an audit on 2026-09-28 found that **the product does not work**. All 413 unit tests, the e2e suite and CI were green, and yet:

| Finding | Evidence |
|---|---|
| Installing `@remora/host` into dsh **crashes dsh on startup** | `cannot get property "typertGateway" without inject`, dsh exit 1 (host `apply()` declares `inject: []` and reads `(ctx as any).typertGateway`) |
| No test ever calls the real plugin entry point `apply()` | e2e tests assemble host pieces by hand and use a hand-written fake dsh gateway (`useRealDsh: false` everywhere) |
| Host never registers with the relay | `enrollHost()` exists but nothing in `apply()` calls it; tests call it manually |
| Host identity is random on every start | `createHostIdentity()` called with no stored keys → every restart breaks every pairing |
| Paired devices forgotten on restart | `new PersistentDeviceRegistry()` without a path is in-memory only; notify prefs in-memory too |
| "Turn done"/"turn error" pushes never fire | handlers assume wrong event shapes: dsh emits `session/event` as `(session, event)` and `agent/error` as `{ agent, turn, step, error }` |
| Keep-awake is a no-op on Windows | looks for `globalThis.koffi`, which never exists |
| Documented tarball install cannot work | packed `@remora/host` depends on unpublished `@remora/crypto`, `@remora/protocol`, `@remora/relay-link` |
| Android app lock is a button that unlocks without a biometric | `AppLockScreen` "Unlock (placeholder)" |
| Android loses its pairing keys on every restart | `SecureKeyStorage(context)` encrypts with a random key that is never persisted; no Keystore/Tink |
| No QR scanning | ML Kit declared, never called; pairing link is pasted as text |
| No pushes can arrive | `onNewToken` is a `TODO`; the FCM token is never sent to the relay |
| Phone never receives approval requests | app never opens `interaction.follow` (nor `sessions.control`, `workspaces.follow`) |
| Host lacks `devices.self`, `devices.unpair`, `devices.rotateApprovalKey` | app calls `devices.rotateApprovalKey` |
| 27 of 33 conformance vector files are placeholders | `"status": "scaffold"` cases; TypeScript↔Kotlin parity mostly unchecked |
| Reports claim work that could not have happened | P0-S5 claims "50 signatures across Android devices" (only `verify.mjs --help` was run); `device-test.md` marks 8 phone steps "Pass" with no phone; `operations.md` tells the owner to run `dsh credentials … set`, a command dsh does not have; P6-O1 claims a v1.0.0 release, no tag exists |

**What is real and should be kept:** the relay (tested in workerd), the Noise implementation (passes the official Cacophony vector in both languages), approval-signature verification on the host, the Policy Guard logic, and the P0-S1 spike fixtures recorded from real dsh.

The lesson drives every rule below: **green tests and confident reports proved nothing, because the tests never touched the real system and nobody checked the claims.** In this phase, only evidence a machine produced counts.

## 1. The five rules

1. **Evidence is produced by CI, never by prose.** A claim in a PR or handoff ("verified", "confirmed", "works", "Pass") without a command, its real output excerpt, and the CI run link is treated as false. Never write "Pass" in a runbook unless you are the owner holding the phone.
2. **Red first, then green.** Each code task's first commit adds the acceptance test(s) and **must fail CI** for the reason the packet states. The second commit fixes the code. The PR description links both CI runs. A PR without a red run is rejected.
3. **Test the real thing.** Do not mock the unit under test. Host code is tested through `apply()` on a real Cordis context or through real dsh (`tests/real-dsh/`). Android security code is tested through the real Android APIs (instrumented or Robolectric where the packet says so). Fakes are allowed only for the *other side* of a boundary, and the packet names which.
4. **Stay inside `owned_paths`.** Never edit protected paths (§4). Never skip, delete, loosen, or `.skip` a test. Never lower a gate. If you cannot pass honestly, stop and report (§6).
5. **Anything that needs a phone, a Cloudflare/Firebase account, a secret, or a signing key is an `owner-action` task.** Swarm agents never claim those done; they prepare everything and leave the checkbox unticked with `OWNER-PENDING`.

## 2. Roles in the swarm

| Swarm role | Count | Does | Never |
|---|---|---|---|
| **Worker** | many | implements exactly one packet on branch `task/<id>-<slug>`; opens a PR | reviews its own PR; touches protected paths |
| **Verifier** | ≥ 1 per 4 workers | checks out a worker's PR, re-runs the packet's *Verify* commands and the §5 gates from scratch, compares with the PR claims, posts a PR comment `VERIFIER: PASS` or `VERIFIER: FAIL` with the raw output | writes production code in the same PR |
| **Integrator** | 1 (strongest model available, or the owner) | merges PRs in wave order after `VERIFIER: PASS` + green CI; resolves conflicts; answers stop-and-report | merges without a verifier pass |
| **Owner** (human) | 1 | does `owner-action` tasks; approves changes to protected paths | — |

A worker may not verify its own PR, and a verifier may not verify a PR whose worker shares its session/context.

**Current setup (from 2026-10-02):** the GLM 5.3 Flash swarm is back as Workers, Verifiers and Integrator. From 2026-10-01 to 2026-10-02 Claude acted as Integrator/Verifier with Opus workers; that phase merged P7-H2, P7-H8, P7-R1 and several gate fixes. `.claude/agents/remora-worker.md` is the Claude-specific worker definition; GLM agents use the prompt templates in §7 and §8.

**Lessons from the audits (apply them):**
- A gate test can itself be wrong. If a packet's acceptance looks impossible to meet honestly, inspect the gate and stop and report (§6). Do not work around it. Example: `boot.spec.ts` once recorded the host id only after an assertion that could not pass yet.
- Read real dsh output, not only the assertion line. The real-dsh CI logs and `tests/real-dsh/artifacts/` show exactly what dsh printed.
- On Windows, dsh runs under a `cmd.exe` shell; kill process trees, not pids (see `tests/real-dsh/harness.ts`).
- A PR whose CI jobs did not run (for example, billing or cancelled runs) is not verified. Re-run them before merging.

## 3. Waves (strict order)

Start a wave only when **every** packet of all earlier waves is merged. Inside a wave, packets run in parallel (their `owned_paths` do not overlap; if two packets share a file the later one lists the earlier in `depends_on`).

| Wave | Goal | Packets |
|---|---|---|
| **0 — Gates & honesty** | make fabrication impossible to merge; correct false docs | P7-G1, P7-G2, P7-G3, P7-D1, P7-C1, P7-O6 (owner) |
| **1 — Host boots for real** | plugin loads in dsh, persistent identity, enrolls, remembers devices, packaging | P7-H1 → P7-H2 → P7-H3, P7-H4, P7-H8, P7-H9 |
| **2 — Host completeness** | events, keep-awake, device methods, approval bridge, real-dsh e2e | P7-H5, P7-H6, P7-H7, P7-H10, P7-R1, P7-R2, P7-T1 |
| **3 — Android real** | keys, lock, QR, subscriptions, pushes, screens | P7-A1, P7-A2, P7-A3, P7-A4, P7-A5, P7-A6, P7-A7 |
| **4 — Contracts & vectors** | fill every vector, parity in both languages, flip strict gates | P7-V1, P7-V2, P7-V3 |
| **5 — Real-world verification** | owner runs the phone, Cloudflare, Firebase; final e2e | P7-O1…P7-O5 (owner), P7-T2, P7-X1 |

Wave numbers are also on the issues as labels (`wave:0` … `wave:5`).

## 4. Protected paths (owner approval required)

These are the gates. A worker PR that modifies them is rejected unless its packet explicitly owns them **and** the owner approves the PR. Packet P7-O6 turns this into GitHub branch protection with `CODEOWNERS`.

- `.github/workflows/**`, `.github/CODEOWNERS`
- `scripts/check-*.mjs`, `scripts/gates.allow.json`
- `tests/real-dsh/**` (after P7-G1 merges)
- `conformance/schema/**`
- `docs/SWARM.md`, `AGENTS.md`, `docs/specs/**`, `docs/adr/**`

## 5. Gates every PR must pass

| Gate | Command | Introduced by |
|---|---|---|
| Build, types, lint, unit | `pnpm run build && pnpm run typecheck && pnpm run lint && pnpm test` | existing |
| No stubs in production code | `node scripts/check-no-stubs.mjs` | P7-G3 |
| Plugin loads through `apply()` on real Cordis | `pnpm -F @remora/host test -- apply` | P7-H1 |
| **Real dsh boot** | `pnpm test:real-dsh` (CI job `real-dsh`) | P7-G1 |
| Conformance (strict from wave 4) | `pnpm run conformance:check -- --strict` | P7-G2 |
| Android | `cd apps/android && ./gradlew assembleDebug testDebugUnitTest` | existing |
| Real-dsh e2e (from wave 2) | `pnpm test:real-dsh:e2e` | P7-T1 |

**From the merge of P7-H3, `real-dsh` is green on `main`** (both tests, ubuntu and windows). Every later PR must keep it green: a red `real-dsh` run is a regression and blocks the merge, even though branch protection does not enforce it yet.

## 6. Stop and report

Comment on the issue with the label `blocked`, mention the Integrator, and stop — do not "make it pass" — when:

- the honest fix needs a file outside `owned_paths` or a protected path;
- real dsh behaves differently from the packet or `docs/upstream/dsh-integration.md` (paste the exact log);
- a test can only pass by mocking the thing it tests;
- the task needs an owner action;
- you have spent more than 3 attempts on the same failing check.

## 7. Worker prompt template

Give each worker agent exactly this (fill the id):

```text
You are a Worker in the Remora swarm. Task: <TASK_ID> (GitHub issue #<n>).
1. Read docs/SWARM.md fully, then AGENTS.md, then docs/tasks/<TASK_ID>.md and every file it lists under Inputs.
2. Work on branch task/<TASK_ID>-<slug> from the latest main. Touch only the packet's owned_paths.
3. Commit 1: add the acceptance tests. Push. Confirm CI fails for the reason the packet predicts. Save the run URL.
4. Commit 2+: implement until the tests and every gate in SWARM.md §5 pass locally. Push. Save the green run URL.
5. Write docs/agent-handoffs/<TASK_ID>.md from the template: real commands, real output excerpts, both CI run URLs,
   and every acceptance box either ticked with evidence or left unticked with OWNER-PENDING or BLOCKED and the reason.
6. Open a PR titled "<TASK_ID>: <summary>" with "Closes #<n>". Do not merge. Do not close the issue yourself.
Never: skip/delete/loosen tests, edit protected paths, use `as any` on Cordis contexts, mock the unit under test,
claim phone/cloud/secret steps, or write "verified"/"Pass" without pasted output. If stuck, follow SWARM.md §6.
```

## 8. Verifier prompt template

```text
You are a Verifier in the Remora swarm. PR: #<pr> for task <TASK_ID>.
1. Read docs/SWARM.md and docs/tasks/<TASK_ID>.md.
2. Fresh clone, checkout the PR branch, run: pnpm install --frozen-lockfile, then every command under the packet's
   "Verify" section and every gate in SWARM.md §5 that applies to the touched paths.
3. Check: the first commit's CI run is red for the predicted reason; the tests exercise the real unit (no mock of it);
   only owned_paths changed (git diff --stat origin/main...HEAD); no protected path changed; no test was skipped or
   weakened (git diff origin/main...HEAD -- '*.test.ts' '*.spec.ts' '*Test.kt'); every claim in the handoff has output.
4. Post one PR comment starting with "VERIFIER: PASS" or "VERIFIER: FAIL", followed by the raw command outputs
   (trimmed) and a list of any mismatches. Do not push commits to the PR.
```

## 9. Definition of done for the whole project

Remora is complete when **all** of these are true, each shown by a linked CI run or an owner-signed handoff:

1. CI jobs `ci`, `android`, `real-dsh`, `real-dsh-e2e`, `conformance-strict`, `no-stubs` are required and green on `main`.
2. `pnpm test:real-dsh:e2e` shows, against real dsh and a local relay: pairing through the management page, sessions list, prompt with streamed reply, cancel, approval answered by the test device, question answered, new session in a root, file read, diff, host restart without re-pairing.
3. The owner completed P7-O1…P7-O5 on a real phone and a deployed relay, with results in `docs/runbooks/device-test.md` filled in by the owner.
4. No issue in milestone P7 is open, and a `v1.0.0` tag exists, created by the owner.

## 10. Token budget guidance (100M tokens)

Rough plan: ~30 worker packets × ~1.5M tokens average (read context, red/green iterations) ≈ 45M; verifiers ≈ 15M; retries and rework ≈ 25M; reserve 15M for the Integrator and wave-5 debugging. Keep each agent's context small: it needs this file, AGENTS.md, its packet, the packet's inputs, and the files it owns — not the whole repository.
