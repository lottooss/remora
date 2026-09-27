# Threat model

Status: **v1-frozen**. Owner: Verification & Security role. Reviewed at P3 exit and P6 exit ([roadmap](../roadmap.md)).
Every mitigation below names the test that proves it; a mitigation without a passing test is not done.

## 1. Assets

| Id | Asset | Why it matters |
|---|---|---|
| A1 | Conversation content, source code, file contents, diffs | confidentiality of your work |
| A2 | The power to make the PC execute actions (prompts, approvals, new sessions) | remote code execution on your PC |
| A3 | Host and device private keys, PSKs, push keys | impersonation, decryption |
| A4 | dsh credentials (DeepSeek API keys, provider secrets) | billing, account takeover — Remora must never expose them |
| A5 | Availability of remote control | convenience only; the PC keeps working locally |
| A6 | Metadata: when you work, how much, which devices | privacy |

## 2. Adversaries

| Id | Adversary | Capabilities assumed |
|---|---|---|
| ADV1 | Network attacker (public Wi-Fi, carrier) | observe/modify/drop traffic |
| ADV2 | Relay compromise (Cloudflare account takeover, insider, bug) | full control of relay code and storage |
| ADV3 | Push provider (FCM) | sees push metadata and payload bytes |
| ADV4 | Thief with a **locked** phone | physical access, no screen lock secret |
| ADV5 | Thief or coercer with an **unlocked** phone | can use the app UI for a short time |
| ADV6 | Non-root malware on the phone | reads shared storage, draws overlays, but no access to other app sandboxes or Keystore key material |
| ADV7 | Other local users/processes on the PC (non-admin) | can reach loopback ports, cannot read your profile |
| ADV8 | Malicious web page in the PC's browser | CSRF, DNS rebinding against localhost |
| ADV9 | Malicious repository or web content read by the agent | prompt injection, hostile git config |
| ADV10 | Stranger who learns the relay URL | anonymous HTTP/WebSocket access |
| ADV11 | Someone who photographs the pairing QR | knows the ticket and pairing secret for ≤ 10 min |

Out of scope: a compromised PC account or administrator (game over), a rooted phone with Keystore bypass, nation-state attacks on X25519/ChaCha20 (the PSK layer gives some post-quantum hedging only if the PSK stays secret).

## 3. Threats and mitigations

| Id | Threat | Adv. | Mitigation | Test |
|---|---|---|---|---|
| T01 | Relay or network reads content | 1, 2 | Noise IKpsk2 E2E; relay parses only headers | `tests/security/adversarial-relay.spec.ts` (PASS: bit-flip fails closed, no plaintext processed) |
| T02 | Frames injected, modified, reordered | 1, 2 | AEAD with counter nonces; any failure closes the channel | `tests/security/adversarial-relay.spec.ts` (PASS: bit-flip, tampering, splicing fail closed) |
| T03 | Relay impersonates the host to the phone | 2 | host static key pinned from the QR (out-of-band) | `tests/security/adversarial-relay.spec.ts`, `tests/security/pairing-attacks.spec.ts` (PASS: substituted host key rejected) |
| T04 | Relay impersonates a phone to the host | 2 | device static key allowlist + `devicePsk` + relay source id check | `tests/security/adversarial-relay.spec.ts` (PASS: unknown static key and wrong PSK fail closed) |
| T05 | Replay of frames, prompts, approvals | 1, 2 | Noise nonces; `requestId` dedupe; approval id single-use + `issuedAt` ±5 min | `tests/security/adversarial-relay.spec.ts`, `tests/security/approvals.spec.ts` (PASS: replayed transport & replayed answers rejected) |
| T06 | QR photographed and used to pair | 11 | SAS numeric comparison confirmed on the PC; ticket single-use 10 min; device name shown | `tests/security/pairing-attacks.spec.ts` (PASS: unconfirmed SAS, wrong SAS, ticket reuse rejected) |
| T07 | Strangers use the relay | 10 | host enrollment requires secret; device enrollment requires ticket; rate limits; endpoint cap; unknown routes 404 | `apps/relay/test/worker.test.ts` (PASS) |
| T08 | Relay/FCM outage | — | availability accepted as residual; PC keeps working; phone shows offline | Residual risk accepted |
| T09 | Locked phone stolen | 4 | app lock; keys in Keystore/Tink; revoke from PC | `tests/security/limits-and-revocation.spec.ts` (PASS: revoked device channels closed); manual device test runbook |
| T10 | Unlocked phone used to approve a dangerous action | 5 | high-risk approvals require a per-use biometric signature verified by the host; app re-locks after 5 min in background; no approve-from-notification | `tests/security/approvals.spec.ts` (PASS: unsigned high-risk rejected, high-S accepted); `:feature:settings:test` (PASS) |
| T11 | Phone malware extracts keys or overlays prompts | 6 | Keystore non-exportable approval key; Tink-wrapped keyset in app sandbox; `FLAG_SECURE`; BiometricPrompt is system UI | `:feature:settings:test` (PASS: FLAG_SECURE); manual review checklist |
| T12 | Phone reads secrets on the PC via path tricks (`..`, junctions, symlinks, 8.3 names, UNC, `\\?\`) | 5, 6 | Policy Guard canonicalizes and confines reads to session root ∪ roots; denies device/UNC paths | `tests/security/path-escapes.spec.ts` (PASS: 11 path-escape tests on Windows) |
| T13 | Phone starts sessions in sensitive folders | 5 | roots allowlist; `allowRemoteSessionStart` switch | `packages/host/test/policy.test.ts` (PASS) |
| T14 | Prompt injection leads to a dangerous approval approved on a small screen | 9 | exact command/args preview; risk classifier; biometric for high risk; `argsDigest` binds what was shown; answers need the app, not the notification | `packages/host/test/interaction.test.ts`, `tests/security/approvals.spec.ts` (PASS: digest mismatch rejected) |
| T15 | CSRF / DNS rebinding against the management page | 8 | page lives under dsh `/api` (cookie `SameSite=Strict`, Host/Origin fence); state changes are POST with same-origin checks | `packages/host/test/web.test.ts` (PASS: cross-origin POST & rebinding Host rejected) |
| T16 | Local users hit Remora | 7 | Remora opens no port; management page inherits dsh cookie auth; secrets in the user profile | Port scan shows no listening port; `packages/host/test/web.test.ts` (PASS) |
| T17 | Hostile git config executes code during `diffs.*` | 9 | `core.fsmonitor=false`, empty hooks path, `--no-ext-diff --no-textconv`, `--no-optional-locks`, timeouts | `tests/security/git-and-push-hardening.spec.ts` (PASS: malicious hooks, diff, textconv, fsmonitor neutralized) |
| T18 | Push content visible to Google | 3 | payload encrypted with per-device push key; `host_offline` carries metadata only | `tests/security/git-and-push-hardening.spec.ts`, `apps/relay/test/worker.test.ts`, `conformance/vectors/crypto/push.json` (PASS) |
| T19 | Secrets or content in logs | all | redaction helpers; log statements reviewed; tests scan captured logs for known secrets and payload markers | `tests/security/log-scans.spec.ts` (PASS: host, relay, and secret scanning) |
| T20 | Dependency supply chain | — | lockfiles committed; minimal dependencies; audited `@noble/*`, BouncyCastle, Tink; `pnpm audit` / Gradle dependency review in CI | CI dependency audit; `pnpm audit --prod` 0 vulns |
| T21 | A dsh upgrade silently routes approvals around the bridge | — | adapter fixtures per version; startup self-check that the bridge listener is registered and ordered first; CI against npm `next` | `packages/host/test/interaction.test.ts` (PASS: waterfall precedence) |
| T22 | Protocol downgrade | 1, 2 | only v1 exists; `hello` negotiates max common version; relay rejects unknown versions | `packages/protocol/test/rcp.test.ts`, `apps/relay/test/worker.test.ts` (PASS) |
| T23 | Paired device floods the host | 5, 6 | per-device rate limits, stream caps, 48 KiB messages | `tests/security/limits-and-revocation.spec.ts` (PASS: burst & mutating rate limits, message size cap) |
| T24 | Clock manipulation to reuse an approval | 5 | single-use ids are primary; time window is secondary | `tests/security/approvals.spec.ts` (PASS: expired timestamp rejected, replay rejected) |
| T25 | Attacker who knows the phone PIN enrolls a new fingerprint | 5 | approval keys invalidated on biometric enrollment; rotation requires PC confirmation | `:feature:settings:test` (PASS); manual device test runbook |
| T26 | Leaked relay enroll secret | 10 | only enables host enrollment; hosts cannot reach unlinked devices; rotate secret | `apps/relay/test/worker.test.ts` (PASS: scoped host enrollment) |
| T27 | Cloudflare account takeover | 2 | same as ADV2 (content-blind) + junk pushes fail decryption; owner enables 2FA | `conformance/vectors/crypto/push.json`, `tests/security/git-and-push-hardening.spec.ts` (PASS: push AEAD decryption failure) |
| T28 | Stolen relay key used to kick the real device (newest wins) | 6 | relay key alone cannot pass E2E; repeated 4409 surfaces a warning in the app | `packages/relay-link/test/relay-link.test.ts` (PASS: 100 forced disconnects survive) |
| T29 | Push notification ciphertext tampering | 1, 2, 3 | ChaCha20-Poly1305 AEAD per-device push key; bit-flip fails tag verification and drops cleanly | `tests/security/git-and-push-hardening.spec.ts` (PASS: bit-flip & truncation fail closed) |
| T30 | Cross-device push payload injection | 2, 3 | Push payload encrypted with device A's push key cannot be decrypted by device B | `tests/security/git-and-push-hardening.spec.ts` (PASS: key isolation verified) |
| T31 | Host-offline alarm spoofing | 2 | Alarms armed by host presence heartbeat; FCM dispatches only upon missed heartbeat interval | `apps/relay/test/worker.test.ts` (PASS: host-offline alarm delivery) |
| T32 | Notification preference tampering | 5, 6 | `notify.prefs.*` enforced by host policy guard; per-device preferences stored in isolated store | `packages/host/test/notify.test.ts` (PASS: prefs schema and isolation verified) |
| T33 | Android FCM background key exposure | 6 | Phone decrypts payload only inside service sandbox, wipes decrypted plaintext and raw keys with `wipe()` | `apps/android/app/src/test/.../notification/PushNotificationTest.kt` (PASS) |

## 4. Residual risks (accepted for v1)

- The relay operator and Google learn metadata: endpoint ids, connection times, message sizes and counts, push timing.
- Availability depends on Cloudflare and FCM.
- A user can still approve a malicious action shown accurately in the preview.
- No host key rotation without re-pairing.
- Attestation of the approval key is recorded but not enforced in v1.

## 5. Security test checklist (P3-T1, P6-T2)

- [x] Cacophony + Remora Noise vectors pass in TypeScript and Kotlin; cross-implementation handshake in CI.
- [x] Adversarial relay mode in `@remora/testkit` (flip bits, reorder, replay, drop, splice channels) → channel closes, no plaintext accepted (`tests/security/adversarial-relay.spec.ts`).
- [x] Pairing: missing SAS confirmation, ticket reuse, expired QR, substituted host key, wrong PSK (`tests/security/pairing-attacks.spec.ts`).
- [x] Approvals: unsigned high-risk, bad signature, high-S DER accepted, digest mismatch, replay, cross-session id, after revoke (`tests/security/approvals.spec.ts`).
- [x] Path escapes: `..`, absolute outside roots, junction, symlink, 8.3 short name, UNC, `\\?\`, mixed case, trailing dots/spaces (Windows), NUL bytes (`tests/security/path-escapes.spec.ts`).
- [x] Git hardening with hostile repo config (`tests/security/git-and-push-hardening.spec.ts`).
- [x] Push encryption integrity & key isolation (`tests/security/git-and-push-hardening.spec.ts`).
- [x] Log scans (host, relay `wrangler tail` capture, app diagnostics export) contain no secrets or payload markers (`tests/security/log-scans.spec.ts`).
- [x] Management page: cross-origin POST, rebinding Host, missing cookie (`packages/host/test/web.test.ts`).
- [x] Rate limits and size limits at relay and host (`tests/security/limits-and-revocation.spec.ts`).
- [x] Revocation: immediate at host, relay socket closed, FCM token cleared, re-enroll impossible without new ticket (`tests/security/limits-and-revocation.spec.ts`).
