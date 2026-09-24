# ADR-0009: Always-on host via per-user logon supervisor and keep-awake

- Status: Accepted (mechanisms validated in P0-S6: Task Scheduler / HKCU Run via `conhost.exe --headless`, in-process `koffi` for `SetThreadExecutionState`)
- Date: 2026-09-24
- Deciders: Owner, Host, Integrator

## Context

Remote control only works while dsh runs with the Remora bundle. The owner wants it running without a terminal, restarted after crashes, and not interrupted by idle sleep while agents work. dsh must run as the owner's account (it needs the owner's files, credentials, and `$DSH_HOME`). Administrator rights should not be required.

## Decision

- `@remora/cli` provides `remora service install | uninstall | status | logs` and `remora host run`.
- `install` registers a **per-user logon start** without elevation: a Task Scheduler task if P0-S6 proves it can be created unelevated with a logon trigger; otherwise the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` key. The command runs `remora host run` hidden (`conhost.exe --headless`).
- `remora host run` is a supervisor: it launches the **pinned** dsh runtime (`dsh --profile remora --no-open --port 7717`), writes rotating logs to `%LOCALAPPDATA%\Remora\logs`, restarts with capped backoff, and exits cleanly on `service uninstall`.
- The Remora plugin holds a keep-awake request while any root Agent runs, plus a 2-minute grace period (Windows `SetThreadExecutionState`, macOS `caffeinate`, Linux `systemd-inhibit`).

## Consequences

- No admin rights; runs only while the owner is logged in (a locked session is fine; a signed-out one is not).
- Keep-awake prevents idle sleep only; lid close, power button, and battery policies still sleep the PC. The operations guide tells the owner which power settings to change for 24/7 availability; the relay sends `host_offline` when it happens.

## Alternatives considered

- **Windows Service:** needs admin and runs as a different account without the owner's profile. Rejected.
- **NSSM / WinSW wrappers:** admin plus third-party binaries. Rejected.
- **Manual start in a terminal:** not always-on. Kept as the development mode.
