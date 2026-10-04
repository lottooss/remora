# P7-A8 — Android application and host integration

## Implementation

The owner requested implementation first and deferred test waits on 2026-10-04.
The combined branch `codex/finish-remora` includes the H10 answer bridge, approved
H6 keep-awake changes, Android A1–A7 implementations, and an application coordinator.
No phase-exit or independent-verifier acceptance is claimed by this handoff.

- `RemoraViewModel` owns per-host connection/service/repository runtimes. Navigation
  and callbacks carry host identity, including notification deep links. Stale
  selection or a replaced connection cannot send a biometric answer.
- System biometrics gate app access and high-risk signing. Persistent key storage
  uses Android Keystore/Tink. Camera scanning validates the QR before enrollment;
  pairing persists keys before acknowledging the received `pair.complete` id.
- Foreground runtime and push registration reserve identities during pairing and
  connection startup. A 30-second background grace closes normal connections;
  reconnection restores global streams and visible conversation cursors.
- Sessions use real summaries, model catalogs, running/queue/job state, prompt
  acknowledgment, cancellation and paging. Failed sends retain the draft.
- Files/workspaces receive real bound RPC services. Remote creation follows the
  host's authenticated policy rather than a default permission or sample model.
- Settings use actual device/notification methods. Unpairing requires acknowledged
  host revocation. Rotation retains the old private key until the user acknowledges
  PC confirmation; retries reuse the same candidate and request id. The protocol
  has no automatic confirmation event, so the UI does not claim one.
- Host stream consumers return promptly, retain incremental control components,
  use actual dsh activity sources, and dispose their scoped listeners. Rotated
  P-256 keys are validated and normalized to the verifier's canonical SPKI format.
- Diagnostics retain bounded fixed event codes and truncated ids, not content or
  exception messages. App lock and screenshot protection remain enforced.

See the component handoffs for security, data/transport, approval parity, host
streams and key normalization. The task's scheduling/scope amendment is in
`docs/tasks/P7-A8.md`; protected SWARM/spec files were not changed.

## Verification boundary

Only compilation/package construction and source review are part of this coding
pass. Unit, integration, security, conformance, instrumentation and physical-phone
test execution is deferred at the owner's request. Existing H10/H6 evidence was
collected before that instruction and does not validate this combined branch.

- Kotlin `:app:compileDebugKotlin`: passed on the first combined composition.
- Host package build: passed after streaming and key-format fixes.
- Final package-build outcomes are recorded below when available.
- `git diff --check`: source whitespace inspection only, not behavioral evidence.

## Remaining release work

1. Run the repository gates against this complete branch, fix failures, and obtain
   independent verification. Migrate any obsolete fixtures to the authoritative
   schema without weakening their assertions; protected fixture changes still
   require the owner's review where SWARM applies.
2. Reconcile frozen Crypto/1 text with the current TS/Kotlin implementation and
   conformance vectors through the contract-change process. This pass preserves
   existing transport encoding and implements Android approval digest recomputation;
   it does not claim the documented five/ten-line, pairing/SAS, relay-auth or push-AAD
   discrepancies have a final contract decision.
3. Owner phone checks: QR/SAS pairing, real biometric signing and invalidation,
   process-death storage, reconnect/background behavior, notification deep links,
   and key rotation after PC confirmation/rejection/expiry.
4. Owner infrastructure/release steps: Cloudflare configuration/deployment,
   Firebase configuration, release signing, and acceptance on the installed phone.
   No account secrets, owner profile, SDK license or production deployment changed.

No unverified branch is merged. A successful build is not a functional or release
acceptance result.
