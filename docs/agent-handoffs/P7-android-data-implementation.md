# Handoff: P7-A4/A5/A6/A7 Android implementation

- Role: Android
- Agent: Codex
- Date: 2026-10-04
- Branch: codex/android-data
- Status: implementation only; verification deferred by explicit user instruction.

## Changes

- Persisted per-host FCM registration and offline-alert preferences, relay acknowledgments and retry lifecycle; fixed push-key alias zeroization, unknown-host handling and host-bound notification routes.
- Added RCP stream cancellation, errors, sequence checks and bounded early-baseline buffering; secure channel source validation, ordered cipher setup, bounded records, serialized encryption, disposal and rekey; connection hello and reconnect lifecycle.
- Added interaction/control/workspace follow subscriptions and baselines; reconnect restoration of visible session cursors; data services preserve coroutine cancellation.
- Added host/device/settings APIs and localized Hosts, Settings and Diagnostics screens, including remote unpair acknowledgment and explicit pending approval-key activation flow.
- Host metadata uses structured persistence and restores selection without asserting cached online state. Diagnostics accept fixed event codes and retain at most 200 entries.

## Verification

No build, test suite, CI job, emulator, Firebase, or physical-phone check was run. The user requested code first and tests afterward. Source/diff inspection only; no passing-gate claim is made. No push or merge was performed.

## Integration dependencies

Root integrates InteractionCodecs/InteractionModels/InteractionService from the approval worker, durable keys/pairing from the security worker, and DI/navigation/multi-host composition. API signatures were sent to the root before commit.

## Findings reported to Integrator

- Host workspaces.follow awaited its entire unending adapter stream before returning its stream id; root must fix that handler lifecycle.
- Host interaction.follow emits baseline before its response; Android buffers this case within strict limits.
- Host sessions.control currently derives running=false and loses queue/jobs on live updates; root must repair the adapter.
- Existing crypto APIs and frozen prose differ in relay signing, SAS, push AAD and approval canonicalization. No unilateral wire change was made.

## Acceptance and deferred work

All packet test/evidence checkboxes remain unchecked. Build and behavioral verification, instrumented security review, real phone pairing/reconnect/push tests, Firebase configuration and production evidence remain pending. Existing transport fixtures omit required relay version/id fields and will need updates to realistic envelopes during the requested verification pass; validation was not weakened to preserve those fixtures.
