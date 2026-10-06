# GLM continuation handoff — paused 2026-10-05

The owner requested: **“i want glm to continue the project and you to pause. so start pausing”**.
Codex stopped implementation and interrupted all three active workers. No worker remains running.
The owner's instruction **“do whatever is left without testing”** remains in force. Do not execute
tests, conformance gates, smoke checks or CI polling unless the owner changes that instruction.

## Where the work lives

All four branches below start at `6279ab7`. Their latest edits are **uncommitted, incomplete and
not integrated**. Preserve them; do not reset or clean these worktrees. Read their diffs before
continuing. Do not assume the combined source currently compiles.

| Branch | Worktree | Pending changes |
|---|---|---|
| `codex/finish-remora` | `C:/Users/olsis/.codex/worktrees/remora-completion/ds` | Root integration; host pairing/registry/SPKI validation and relay fail-closed fixes |
| `codex/crypto-contract` | `C:/Users/olsis/.codex/worktrees/remora-android-data/ds` | TS/Kotlin normative crypto restoration and production callers; crypto vectors/consumers still unfinished |
| `codex/rcp-vectors` | `C:/Users/olsis/.codex/worktrees/remora-contract/ds` | Protocol event codecs, Kotlin envelope/null and payload validation, RcpClient; generator started, vector/consumer completion unfinished |
| `codex/release-prep` | `C:/Users/olsis/.codex/worktrees/remora-android-security/ds` | Windows CLI service/runtime/lifecycle fixes; release docs and final source review unfinished |

The original workspace is `C:/Users/olsis/Desktop/lotoss/ds`; preserve its existing tracked files
and the owner's untracked `runs.txt`. Work in the integration worktree above.

Draft PR **96**: https://github.com/lottooss/remora/pull/96 (`codex/finish-remora`). Its pushed head
is `6279ab7`, and therefore excludes the uncommitted work described here. Draft PR94 (H10) and
PR95 (H6) are already incorporated into that integration branch. No PR has been merged.

## What was already completed before this paused pass

The pushed implementation includes the real dsh approval/question bridge, Windows Koffi keep-awake,
Android persistent Keystore/Tink keys and biometric app lock/signing, QR pairing, per-host application
composition, reconnect/stream/push lifetime handling, session/file/settings UI wiring, and host
stream/metadata fixes. See `P7-A8-integration.md` and its linked component handoffs.

At `6279ab7`, TypeScript build/typecheck and Android debug assembly had completed. Those results
**do not cover the new uncommitted edits**. The earlier debug APK is at
`apps/android/app/build/outputs/apk/debug/app-debug.apk` in the integration worktree (82,035,889 bytes).
No tests or builds ran during the current paused pass. No cloud deployment, owner-profile changes,
release signing, branch-protection change or physical-phone validation occurred.

## Root edits to finish reviewing

- `packages/host/src/pairing/index.ts`: require a real enrollment-ticket provider; validate message1
  with Zod, require canonical hash-derived device ID matching the relay frame, 32-byte relay key,
  Android platform/app version/name, and strict P-256 SPKI approval key. Remove the alternate raw-key
  device ID acceptance. Use normative host-bound PSK and handshake-hash SAS (APIs live in the other
  worktree). Guard concurrent start/handshake/confirmation, wait for registry persistence, revoke on
  failure, erase transient secrets and dispose timers. Correct `pair.rejected` to envelope `e/d`.
  The two newly wrapped try blocks still need indentation cleanup. Review cancellation and rollback
  races and failure cleanup; no behavioral evidence exists.
- `devices/persistent-registry.ts`: keep a rejecting latest-write promise for `flush()` while the
  serialized queue recovers; remove stale Noise-key index entries on replacement. DeviceRegistry
  gets optional `flush()`. Review write-failure behavior at all callers.
- New `identity/approval-key.ts`: strict uncompressed canonical P-256 SPKI via Node key import;
  rotation explicitly permits legacy raw SEC1 input before normalization. The old local helper in
  `rcp/methods/devices.ts` was replaced with this shared helper.
- `host/src/index.ts`: passes `identity.hostId` to interaction registration (new API in crypto
  worktree), disposes pairing, closes relay in finally after registry flush, truncates logged ID.
- `apps/relay/src/account-hub.ts`: remove missing-secret fallback to `test-enroll-secret`; bounded
  strict UTF-8 enrollment body reading; require 32-byte tickets; reject expired/used/revoked-host
  tickets and revoked device identity; consume ticket after capacity checks; persist upgrade origin
  in socket attachment; recompute endpoint ID from key and bind auth query identity; call structured
  relay signature API; validate control frames; bound push fan-out/token; clear FCM token on revoke;
  reject the three reserved trailing header bytes. Review schema compatibility (`auth.app` prose
  currently says object while TS schema says optional string), unknown-control handling, attachment
  migration and ordering. Old socket attachments lacking origin intentionally fail closed.

## Crypto direction and exact unfinished integration

Source audit found both languages agreed on constructions that contradicted the frozen Crypto/1
body: five-line/JCS approvals, ticket-bound PSK, static-public-key SAS, nonce-only relay auth, empty
push AAD. Integrator direction was to **restore the normative security bindings before the unreleased
v1 ships**, with no try-legacy downgrade fallback. All prerelease components must upgrade together;
old inflight signatures, handshakes and queued pushes are incompatible. Stored identity/devicePSK/
pushKey records need not change merely because encoding changes. Formal contract issue/spec/ADR
resolution has **not yet been written**. Do not label this a completed contract decision or rollout.

Worker-announced APIs (inspect actual files):

- `derivePairPsk(pairingSecret, hostId)` and `deriveSasCode(handshakeHash)`.
- `signRelayChallenge(privateKey, { relayOrigin, kind, endpointId, nonce: Uint8Array })` and matching
  `verifyRelayChallenge(publicKey, fields, signature)`; canonicalize origin identically in TS/Kotlin.
- `seal/openPushPayload(key, payloadOrData, { hostId, deviceId })`.
- Ten-line approval fields include host/device/session/call/tool identities; digest is bare lowercase
  hex of SHA256(UTF8(text) + NUL + UTF8(json)). Identity must come from authenticated connection/pending
  host state, never answer-supplied values.
- `registerInteractionMethods(server, pending, registry, policyGuard: PolicyGuard | undefined, hostId)`.
- `HostNotifierOptions` gains REQUIRED `hostId`: root still must pass `identity.hostId` in `host/index.ts`.
- Android `InteractionService` gains REQUIRED third parameter `deviceId: () -> String`, before the
  optional clock lambda. Root still must update `RemoraViewModel.kt`/HostRuntime. Bind the provider to
  the stored pairing material loaded by `connect(runtime)` (material.deviceId), fail when disconnected,
  and retain the host-adjusted clock. Current caller only passes interactions and hostId.
- Crypto vectors, consumer migrations and ordinary test fixture call signatures remain unfinished.
  Authoring fixtures is allowed; executing tests is not. Relay tests still call nonce-only auth.
  Protected `tests/real-dsh/**` may need migration; follow the protected-file authorization rule.

## RCP/vector work

The RCP worker was assigned P7-V2: all 36 method vectors with valid/invalid examples; real Kotlin
payload validators; envelope/events/limits and relay vectors plus both language consumers. Five
obsolete scaffold files are deleted in its worktree (devices.list/rename/revoke, diffs.get,
sessions.get). Inspect generator output before assuming vectors were generated: the pause snapshot
showed the generator untracked but no modified new vector files. Four normative event kinds are
being added in both languages (`user.message`, `assistant.attempt`, `todo.updated`, `notice`) while
retaining older kinds and unknown fallback. Kotlin optional envelope nulls are being omitted.

Prose discrepancies still to resolve under the contract process:

- Errors in both implementations use open nonempty `code`, `message`, optional top-level
  `retryAfterMs >= 0`, optional `details` object; no required `retryable`. Current constants include
  invalid_request/method_not_found/invalid_params/unauthorized/forbidden/not_found/conflict/
  rate_limited/too_large/cancelled/internal_error.
- Unknown enum fallback applies to open presentation enums; security/control discriminators fail
  closed. The spec's blanket rule is inaccurate.
- RCP changelog incorrectly claims ISO timestamps, assistant.delta codepoint offsets and
  hasMoreOlder/50-item snapshots; normative body/current schemas use epoch ms, live.delta and hasOlder.
- Crypto changelog claims JCS despite body specifying text-NUL-json. Correct the contradictory claim.
- IKpsk2 msg1 does not prove PSK possession; PSK is mixed in msg2. Correct Crypto/1 §5.3 wording.

## Release-preparation worker

Pending CLI edits reportedly cover validated arguments/real version, a dedicated pinned dsh runtime,
stable installed CLI snapshot, shell-free Windows task creation and HKCU fallback, start/stop/uninstall
acknowledgment, custom task names, locking, bounded metadata-only lifecycle logs and no raw dsh output.
They were not run or built. Ops/release documentation remains unfinished.

P7-V3 local gate work is also unfinished: `ci.yml` still marks conformance-strict/no-stubs
`continue-on-error`; `scripts/gates.allow.json` is already empty. There is no separate real-dsh-e2e
workflow or `test:real-dsh:e2e` script at the paused head. P7-T1 remains real implementation work,
not just a verification checkbox. Do not claim the whole project is code-complete without accounting
for it. Do not execute any suites to satisfy it under the current user instruction.

## Authorization and owner boundaries

Read SWARM, AGENTS, applicable packets and specs before continuing. Earlier explicit protected-file
approval covers H6's Windows workflow and isolated Koffi installation patch. The latest request to
finish remaining code followed an explicit remaining-work list including contract alignment; root
planned an Integrator scope/contract amendment but had not edited protected specs, ADRs, or further
workflows when paused. Resolve protected scope explicitly without inventing past approvals.

Owner-pending: Cloudflare deployment/secret, Firebase configs, actual remora profile/root/provider
setup, physical-phone/biometric evidence, release keystore/signing, required GitHub checks and release
tag. Do not claim these complete. No merges without the repository's independent verification.

The immediate continuation is to finish/review each uncommitted worktree, commit coherent changes,
integrate them into `codex/finish-remora`, finish the above wiring/docs/fixtures and update draft PR96.
Keep all testing deferred and clearly distinguish source implementation from accepted release evidence.
