# @remora/cli

The `remora` command keeps the Remora host running on the owner's PC: a Windows logon
service (`service install|start|stop|uninstall|status|logs`), the supervised host
process (`host run`), and local diagnostics (`doctor`). Never requires elevation.

- **Specs:** docs/adr/0009-always-on-host.md, docs/blueprint.md §8.11 and §14
- **Implemented by:** P0-S6 (spike), P5-O1, P7-T2 (service hardening)
- **Owner role:** host (AGENTS.md §3)

## Commands

```text
remora service install [--port 7717] [--profile remora] [--task-name RemoraHost] [--dsh-version <v>]
remora service start | stop | uninstall | status | logs [-f] [--task-name RemoraHost]
remora host run [--port 7717] [--profile remora] [--task-name RemoraHost] [--installed-task <name>]
remora doctor [--profile remora] [--relay-url <url>] [--task-name RemoraHost]
remora --help | --version
```

Every option is validated at the boundary (`src/options.ts`): unknown options,
duplicates and bad values exit 64 before any side effect. `--version` prints the real
package version.

## Design rules (enforced in code)

- **Dedicated pinned runtime.** The supervisor launches only
  `%LOCALAPPDATA%\Remora\runtime\node_modules\@deepseek-ai\dsh` at the version pinned
  in `upstream.lock.json` (`src/runtime.ts` verifies name, version and entry point); a
  global `dsh` on PATH is never used. Install it with
  `npm install @deepseek-ai/dsh@<pinned>` inside that directory
  (docs/runbooks/operations.md §3).
- **Stable installed snapshot.** `service install` copies the compiled CLI to
  `%LOCALAPPDATA%\Remora\services\<task>\cli`, writes a non-secret `config.json`
  (profile, port, task name, `DSH_HOME`), and registers
  `host run --installed-task <task>`. The service never reads the repository checkout,
  and an installed copy can reinstall itself without copying over its own files.
- **Shell-free Windows registration.** The scheduled task is created through
  `Register-ScheduledTask` with single-quoted literals delivered via
  `-EncodedCommand`, and executes `conhost.exe --headless <node> <bin.js> …` directly —
  no `cmd.exe` anywhere. If Task Scheduler refuses, an `HKCU\…\Run` entry is the
  fallback; `service uninstall` removes whichever exists and reports what it did.
- **Locking.** `supervisor.json` in the per-task service directory is created
  exclusively (`wx`) and checked for liveness; a second supervisor for the same task
  name refuses to start, and install is refused while one is running. The Task
  Scheduler settings additionally use `MultipleInstances IgnoreNew`.
- **Acknowledged lifecycle.** `start`, `stop` and `uninstall` poll real supervisor
  state and report success only for what they observed. Stop is requested through a
  `stop-request` file the supervisor watches; nothing is ever killed from a stored
  PID. On Windows the supervisor terminates its own dsh child as a process tree
  (`taskkill /T`), never anyone else's process.
- **Metadata-only logs.** The supervisor writes fixed lifecycle facts to
  `%LOCALAPPDATA%\Remora\logs\<task>\remora-YYYY-MM-DD.log`, capped at 1 MiB per day
  and pruned by retention. dsh output is never captured or logged because it can
  contain conversation content and the browser credential (AGENTS.md §1.8);
  `service logs` tails only this bounded log.

Status: CLI implementation complete. Windows end-to-end service validation is task
P7-T2 (protected CI workflow, not yet authored) and real-machine acceptance is
OWNER-PENDING (docs/runbooks/operations.md §10).
