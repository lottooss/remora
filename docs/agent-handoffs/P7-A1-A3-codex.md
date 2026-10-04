# Handoff: P7-A1–P7-A3 — Android security and pairing implementation

- Role: Android worker, with Integrator-approved ownership for cohesive pairing/security implementation.
- Agent: Codex.
- Date: 2026-10-04.
- Branch: `codex/android-security`; local commit only, no push or PR.

## Summary

Implemented persisted Keystore-backed Tink storage, system biometric app authentication and CryptoObject signing, lifecycle-bound QR scanning, strict pairing validation and identity checks, persistence-before-ack, cleanup on failure/cancellation, and pending approval-key rotation. App composition accepts the Integrator's `RemoraViewModel` and forwards its real signing callback into navigation. Notification permission and initial Firebase token retrieval run after unlocking when Firebase configuration exists.

## Changed paths

Core security and its instrumentation/unit test sources; `core/data/PairingService.kt`; pairing feature; app activity/root/lock wiring, manifest, resources and Gradle dependencies; version catalog. Integrator-owned navigation and repository composition are not edited here.

## Verification

No build, test suite, CI, or physical device check was executed. The owner explicitly directed: “dont wait for tests. Just boom boom code, finish it than we can test it”. Existing storage assertions were moved to Android instrumentation so they exercise real Keystore/Tink and a newly constructed storage instance; the former in-memory constructor was removed. Existing lock tests now authenticate through a fake system boundary, with additional refusal/race cases. Pairing validation cases were added without running them.

`git diff --check` was used only to inspect patch whitespace and the reported extra EOF blank lines were removed. This is not compilation, test, or security evidence.

## Acceptance status

- [ ] P7-A1 persistence/wipe instrumented acceptance: implementation and test source present; execution deferred.
- [ ] P7-A2 biometric lock/signature acceptance: implementation and unit source present; execution and independent security review deferred.
- [ ] P7-A3 scan/validation acceptance: implementation and unit source present; execution deferred.
- [ ] OWNER-PENDING: camera permission, scan, SAS confirmation, biometric cancellation/success/invalidation, process restart, actual relay, and phone background checks.
- [ ] OWNER-PENDING: protected Android instrumentation workflow approval. No workflow was changed.

## Deviations and limits

The owner's direct coding-first instruction overrides red-first CI for this task. The app currently requires strong biometrics; it does not invent a credential fallback without host policy. It rejects HTTP even in debug builds. No gate, test expectation, crypto spec, vector, or public crypto API was weakened.

The existing TS host and Kotlin crypto implementation use ticket-derived pairing PSK context and static-key/PSK SAS inputs, whereas frozen Crypto/1 §5 documents host-ID context and handshake-hash SAS. This worker preserves actual implementation parity and reported the discrepancy to the Integrator; contract remediation remains separate. Existing host `pair.rejected` uses `m` while RCP's event envelope documents `e`; receipt is handled as rejection and does not authorize pairing.

Legacy pairing records encrypted with an ephemeral process key cannot be migrated after restart; they fail closed and require re-pairing. Approval-key rotation preserves a pending alias across restart and requires explicit PC confirmation before local activation; the current device contract does not expose an authoritative active-key readback. Root composition supplies this confirmation UI.

## Unblocks

Integrator composition of real Android transport, pairing, approvals, and settings; subsequent Android build/unit/instrumented checks and P7-O4 owner phone verification. This handoff does not claim gates, CI, or phone success.
