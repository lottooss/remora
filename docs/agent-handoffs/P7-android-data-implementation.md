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

## Source-review follow-up

Added an explicit temporaryConnectionsAllowed callback to the registrar so the composition root can reserve foreground/pairing identities before their sockets exist. Removed the unused duplicate settings rotation method; InteractionService is the single rotation implementation. No build or test execution was added.

## Conversation follow-up (2026-10-05)

ConversationScreen now awaits a suspend Boolean prompt callback, retains drafts after unconfirmed/error responses, prevents concurrent sends, and clears only the acknowledged draft (without erasing edits made while waiting). Running state prefers sessions.control; queued messages and background jobs are displayed from that repository. New text is localized. The conversation module declares its existing workspace coroutine dependency explicitly. This change follows the approval worker commit locally; the Integrator should cherry-pick only the new conversation commit, not duplicate the approval commit. No tests or build were run.

## Handshake ownership and hello boundary (2026-10-05)

SecureChannel gives HandshakeState independent copies of its private key and PSK. Noise finishHandshake wipes only the private-key copy; finally wipes both copies on success, failure and cancellation. The owner device key and PSK are preserved for pairing persistence, SAS and reconnect. Hello now validates roots, policy, identity, versions, feature strings, limits and clock before exposing the RCP client to UI/services. This is source-reviewed implementation, not runtime evidence; no tests/build ran.
