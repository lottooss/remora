# Device test script

Manual end-to-end checks on a real phone, run before every release and at the P2, P3, P5 and P6 exits. P2-T1 fills in the P2 section; later tasks extend it. Record each run in the task's handoff report: date, app/host/relay versions, phone model and Android version, pass/fail per step, and log excerpts for failures.

## Setup

- Relay deployed (or `wrangler dev` reachable from the phone on the same network for debug builds).
- Host running in profile `remora` with at least one allowlisted root.
- Debug or release APK installed.

## P2 — Pairing and sessions

| # | Step | Expected |
|---|---|---|
| 1 | Pair via QR; confirm SAS on PC | App shows the host online |
| 2 | Open a session with history | Transcript loads; older pages load on scroll |
| 3 | Send a prompt while the agent is idle | Answer streams live; final message matches the PC GUI |
| 4 | Send a prompt while a turn is running (queue) | Appears queued; runs after the current turn |
| 5 | Toggle airplane mode mid-stream for 20 s | Transcript converges; no duplicates or gaps |
| 6 | Tap Stop during a long turn | Turn ends as cancelled on phone and PC |

## P3 — Interaction and safety (P3-K1 fills in)

## P4 — Remote work (P4-K1, P4-K2 fill in)

## P5 — Notifications and always-on (P5-K1, P5-O1 fill in)
