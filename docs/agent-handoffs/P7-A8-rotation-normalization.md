# Handoff: P7-A8 — host approval-key rotation format repair

- Role: Android/security worker, with explicit Integrator extension to the host rotation boundary and existing fixtures.
- Agent: Codex.
- Date: 2026-10-05.
- Branch: `codex/android-security`; local commit, no push.

## Change

Fresh pairing supplies SPKI DER, and `verifyApprovalSignature` parses SPKI and expects DER ECDSA signatures. The rotation endpoint previously accepted only unchecked 65-byte SEC1 points and persisted those unchanged, which made its stored keys unusable by that verifier. It now imports SPKI or legacy uncompressed SEC1 with Node `createPublicKey`, restricts the key to P-256, rejects malformed/off-curve/noncanonical inputs, and exports canonical SPKI for the pending rotation. PC confirmation and request ID semantics are unchanged. Android already preserves SPKI and DER; no phone-side format conversion was added.

## Evidence and deferred checks

Read the actual host pairing, rotation, policy verifier, crypto verifier, registry, and combined Android signing sources. Ran `node scripts/fetch-upstream.mjs`; it returned pinned tag `dsh-v0.1.5-rc.3` at `a4c74a91e0`. No dsh seam was changed or runtime re-verified.

No build, unit suite, security suite, CI, or phone check was run, per the owner's coding-first instruction. Existing rotation test fixtures now use valid deterministic curve points and expect canonical SPKI on activation; added source cases cover Android SPKI, subsequent DER verification, off-curve rejection, and trailing DER bytes. These are unexecuted test sources, not acceptance evidence.

## Limits

Registry deserialization currently accepts either stored key format without normalization. No migration was added or record touched. Previously persisted SEC1 keys remain incompatible with the SPKI verifier until an explicit PC-confirmed rotation; fresh Android pairing already stores SPKI. Independent security review and required gates remain deferred.
