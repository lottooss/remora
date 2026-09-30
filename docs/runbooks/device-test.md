# Device test script

> **Only the owner fills this table, on a real phone. Automated tests do not count.**
> Audit 2026-09-28: every result cell below was cleared — the "Pass" marks previously recorded here were unsubstantiated (no phone was ever connected; see [SWARM.md §0](../SWARM.md#0-why-this-phase-exists-read-this-it-is-not-optional)). Until the owner records a real run, treat every step below as untested.

Manual end-to-end checks on a real phone, run before every release and at the P2, P3, P5 and P6 exits. P2-T1 fills in the P2 section; later tasks extend it. Record each run in the task's handoff report: date, app/host/relay versions, phone model and Android version, pass/fail per step, and log excerpts for failures.

## Setup & Prerequisites

- **Relay**: Deployed Cloudflare Worker or local `pnpm -F @remora/relay run dev` reachable from the phone on the same Wi-Fi subnet (e.g. `http://192.168.1.x:8787`).
- **Host**: Running in profile `remora` or `remora-dev` with at least one allowlisted workspace root:
  ```sh
  pnpm -F @remora/host run build
  dsh --profile remora-dev --no-open --port 7718
  ```
- **Android Device**: Physical phone or Android Virtual Device (API 34+) with debug APK installed:
  ```sh
  cd apps/android
  ./gradlew assembleDebug
  adb install -r app/build/outputs/apk/debug/app-debug.apk
  ```

## Where to Find Logs

- **Host (PC)**:
  - Terminal stdout where `dsh --profile remora-dev` is running.
  - dsh runtime logs: `~/.dsh/profiles/remora-dev/logs/`.
  - Plugin logs formatted with `[remora:host]` prefixes.
- **Relay**:
  - Local worker terminal (`wrangler dev`).
  - Production logs: Cloudflare Dashboard -> Workers -> Remora Relay -> Live Tail (`npx wrangler tail`).
- **Android Phone**:
  - Via ADB:
    ```sh
    adb logcat -s Remora:V RemoraProtocol:V RemoraCrypto:V
    ```
  - Logcat filter in Android Studio: `package:mine tag:Remora`.

## P2 — Pairing and sessions

| # | Step | Expected | Result (owner fills) |
|---|---|---|---|
| 1 | Launch Remora on PC; click "Pair New Device" to generate QR; scan QR in Android app | 6-digit SAS code appears on both phone and PC screen; after clicking "Confirm" on PC, phone completes pairing and displays host online |  |
| 2 | Open an active or historical session from the sessions list | Transcript loads with turn history; older messages load smoothly via pagination |  |
| 3 | Send a prompt while the agent is idle | Real-time text delta streaming displays in message bubble (`live.start` -> `live.delta` -> `live.end`); final settled message renders with markdown and matches the PC GUI |  |
| 4 | Send a prompt while a turn is running (`delivery: queue`) | Item appears with "Queued" indicator and begins execution immediately after the current turn completes |  |
| 5 | Send a steering instruction while a turn is running (`delivery: steer`) | Steering input is prioritized and injected into the running turn context |  |
| 6 | Toggle airplane mode mid-stream for 15–20 s, then reconnect Wi-Fi | Transport disconnects cleanly; upon reconnection, Noise IKpsk2 channel re-authenticates and resumes stream via `afterSeq` without missed tokens or duplicate frames |  |
| 7 | Tap Stop / Cancel during an active turn | Ongoing turn ends immediately; session status updates to cancelled on both phone and PC |  |
| 8 | Restart host PC process while phone app is idle | Phone reconnects to host when host comes back online; sessions list and transcript resume without needing to re-pair |  |

## P3 — Interaction and safety (P3-K1 fills in)

## P4 — Remote work (P4-K1, P4-K2 fill in)

## P5 — Notifications and always-on (P5-K1, P5-O1 fill in)
