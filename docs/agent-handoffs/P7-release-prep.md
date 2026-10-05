# Handoff: P7 release preparation — Windows CLI service hardening + release docs

- **Role:** host (release-preparation worker, per `.scratch/P7-GLM-resume.md` §"Release-preparation worker")
- **Agent:** ZCode (GLM)
- **Date:** 2026-10-05
- **Branch / PR:** `codex/release-prep` (integration branch; no PR opened, nothing merged)
- **Commit:** see `git log` on the branch (code commit + docs commit)

## Summary

Finished the paused, uncommitted CLI release-preparation pass in
`C:/Users/olsis/.codex/worktrees/remora-android-security/ds`: validated arguments and a
real version string, a dedicated pinned dsh runtime, a stable installed CLI snapshot,
shell-free Windows task creation with an HKCU fallback, acknowledged
start/stop/uninstall, custom task names with instance locking, and bounded
metadata-only lifecycle logs. Completed the ops/release documentation, including an
OWNER-PENDING release checklist. All prior worker edits were reviewed hunk-by-hunk and
kept; no work was reset or discarded.

## Changed paths

- `apps/cli/src/options.ts` (new) — CLI option parsing/validation, `CliUsageError`
- `apps/cli/src/runtime.ts` (new) — pinned dsh runtime resolution (`PINNED_DSH_VERSION`
  matches `upstream.lock.json`; verified the published package manifest has
  `bin.dsh = lib/bin.js` in `.upstream/deepseek-harness/apps/cli/package.json`)
- `apps/cli/src/process-state.ts` (new) — per-task service dir, supervisor liveness
- `apps/cli/src/service.ts` — snapshot install, `Register-ScheduledTask` via
  `-EncodedCommand` (no `cmd.exe`), HKCU fallback, start/stop/uninstall with observed
  outcomes, bounded metadata-only log tail
- `apps/cli/src/supervisor.ts` — exclusive `supervisor.json` locking, stop-request
  watcher, dedicated-runtime launch (`stdio: 'ignore'`), process-tree termination of
  the owned child only, 1 MiB/day metadata log cap, log retention
- `apps/cli/src/main.ts` — dispatch with validated options, `--installed-task`,
  start/stop subcommands, real `--version`
- `apps/cli/src/paths.ts` — per-task log dirs, resolved `DSH_HOME`
- `apps/cli/src/doctor.ts` — dedicated-runtime check, RLY/1 `/v1/health` body check
  (matches `apps/relay/src/index.ts`), registry-vs-liveness separation, no subprocess
  output in messages
- `apps/cli/test/main.test.ts` — version expectation 1.0.0 (matches package.json)
- `apps/cli/README.md` — command surface and design rules
- `docs/runbooks/operations.md` — dedicated runtime install (§3), service lifecycle
  rewrite (§4), corrected stale keep-awake (P7-H6 landed) and persistence (P7-H2/H4
  landed) notes (§4, §8.2), troubleshooting rows (§9), OWNER-PENDING release checklist
  (§10)
- `docs/agent-handoffs/P7-release-prep.md` — this report

## Verification

| Command | Result |
|---|---|
| `pnpm -F @remora/cli run build` | pass (tsc emit, lib/ layout incl. `bin.js`) |
| `pnpm -F @remora/cli run typecheck` | pass |
| `pnpm run typecheck` (all workspaces) | pass |

Per the owner's standing instruction ("do whatever is left without testing") **no test
suites, conformance gates, smoke checks or service installation were executed**. The
actual Windows service lifecycle has no behavioral evidence yet.

## Acceptance criteria (work order)

- [x] Validated CLI arguments and a real version string (`options.ts`; `--version`
      reads `apps/cli/package.json` = 1.0.0; bad input exits 64 before side effects)
- [x] Dedicated pinned dsh runtime, no reliance on the interactive profile
      (`runtime.ts`; supervisor and doctor resolve only `%LOCALAPPDATA%\Remora\runtime`;
      install refuses without it)
- [x] Stable installed CLI snapshot (`service.ts` copies the compiled CLI per task;
      the task runs `host run --installed-task <name>` from the snapshot only)
- [x] Shell-free Windows task creation + HKCU fallback (`Register-ScheduledTask`
      through `-EncodedCommand`, `conhost --headless` execute path, `reg.exe` via argv;
      no shell interpolation of any value)
- [x] start/stop/uninstall acknowledgment (outcomes polled against real supervisor
      state; stop via `stop-request` file; no killing from stored PIDs)
- [x] Custom task names (`--task-name`, validated; scopes state, logs and task) and
      locking (exclusive-create state file + liveness; install refuses while running;
      `MultipleInstances IgnoreNew`)
- [x] Bounded metadata-only lifecycle logs; NO raw dsh output in logs (dsh spawned
      with `stdio: 'ignore'`; fixed-string log lines; 1 MiB/day cap; retention prune)
- [x] Ops/release documentation finished with explicit OWNER-PENDING items
- [x] Protected P7-V3/T1 gate work NOT touched (see Deviations)

## Deviations from the packet

- Packet P7-T2 owns `apps/cli/test/**` and `.github/workflows/real-dsh.yml`; this pass
  implements the service surface in `apps/cli/src/**` on the Integrator-directed
  `codex/release-prep` branch (the paused prior worker's edits lived there).
- Non-Windows automated service install was removed (previous systemd/launchd writers
  were untested scaffolding); the CLI now reports that only Windows is automated and
  points to `host run` + the platform's user service manager. P7-T2 is Windows-only.
- Protected `.github/**` gate flips (P7-V3: `ci.yml` `continue-on-error` removal,
  a real-dsh-e2e workflow, `test:real-dsh:e2e` script) were NOT implemented — they
  need owner approval and remain open.

## Known limitations / follow-ups

- If the supervisor is hard-killed, its dsh child can outlive it and hold the port;
  the supervisor deliberately never kills a stored PID, so the next start retries with
  backoff until the orphan exits (documented in operations.md §9).
- Once a daily log reaches 1 MiB, further entries that day are dropped silently
  (bounded-by-design; noted in the README).
- `doctor --relay-url` requires an HTTPS origin with no credentials/query/path; the
  local `wrangler dev` relay (http://127.0.0.1:8787) is reported as a warning by design.
- `startService` waits up to 5 s for the supervisor state file; very slow machines
  could report a false "did not report startup" (retry is safe).
- P7-T2's CI workflow (install with temp `DSH_HOME` + custom task name, trigger,
  restart assertion, uninstall assertions) still needs authoring in the protected path.

## Unblocks

- P7-T2 workflow authoring (after owner approval for `.github/workflows/**`)
- Owner execution of operations.md §10 (wave-5: P7-O1…P7-O5)
