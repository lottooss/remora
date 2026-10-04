# Handoff: P7-A8 — Android approval and question payload consistency

- **Role:** Android / Protocol & Crypto, Integrator-assigned implementation scope
- **Agent:** Codex
- **Date:** 2026-10-04
- **Branch / PR:** `codex/approval-parity` / no PR or push requested for this coding phase

## Summary

Android now keeps a dedicated approval preview containing both the displayed text and raw JSON string. The interaction service recomputes the current TypeScript host's preview digest before requesting a biometric signature, rejects changed or expired pending state, and validates complete response fields before resolving local state. The inbox and conversation display both digest inputs. Questions retain every question ID, option label, detail, header, and plan-review intent, and submit structured answer objects. Key rotation includes its required request ID and recognizes only the pending-PC-confirmation response.

The service is scoped to one host and checks the selected host ID passed by its caller. The app composition owner must route its RPC callback and signing provider to the same authenticated connection and recheck selection after asynchronous signing; this service does not infer transport identity from an arbitrary callback.

## Changed paths

- `apps/android/core/crypto/src/main/kotlin/io/github/lottooss/remora/core/crypto/Approval.kt`
- `apps/android/core/data/src/main/kotlin/io/github/lottooss/remora/core/data/Interaction{Models,Codecs,Service}.kt`
- `apps/android/feature/conversation/src/main/kotlin/io/github/lottooss/remora/feature/conversation/{ApprovalsScreen,ConversationScreen,InteractionTakeover}.kt`
- Conversation string resources and existing data/conversation test fixtures migrated to the corrected models and method signatures.

## Verification

**Deferred at the user's explicit instruction to finish coding before tests.** No Gradle build, unit suite, security suite, conformance run, phone run, or CI job was run. No red/green CI evidence is claimed and this is not a phase-exit verification report.

Source inspection included the current TS approval implementation, `PendingApprovalSchema`, `PendingQuestionSchema`, answer response schemas, rotation schema, and Android call sites. `git diff --check` returned exit code 0 with no output before this report was added. Existing test fixtures were migrated, not executed.

## Deferred contract decision

The existing host emits `sha256:` plus SHA-256 of JCS `{json: preview.json, text: preview.text}` and signs five lines: domain, approval ID, digest, outcome, issuedAt. Android now follows that existing encoding, including ECMAScript string escaping and preservation of the raw JSON string. No TS wire implementation, frozen spec, existing vector meaning, or ADR changed.

Crypto/1 §7's body still describes a different text/NUL/JSON digest and ten identity-binding lines, while its changelog describes JCS. This conflict remains unresolved. Local host/pending checks are not a substitute for host/device/session/tool fields cryptographically bound into the signature. The Integrator must complete the coordinated contract decision and cross-language signature/digest/negative vectors before claiming signed-approval completion.

## Remaining evidence

- [ ] Android build and unit checks, including migrated fixtures.
- [ ] Digest parity cases covering controls, quotes, backslashes, Unicode pairs and lone surrogates.
- [ ] Pending removal, expiry, changed host, malformed response, and altered JSON rejection coverage.
- [ ] Independent security review and real biometric/host exchange on the owner device.
- [ ] Final P7-V1/P7-V2 conformance coverage after contract reconciliation.

## Unblocks

App composition can call `InteractionCodecs.parsePending(JsonObject): PendingInteraction?`, route each host to its own repository/service, display raw previews, and provide the biometric signer. P7 completion and P7-V1/P7-V2 acceptance are not claimed.
