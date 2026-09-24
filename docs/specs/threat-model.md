# Threat model

Status: **v1-draft**. Owner: Verification & Security role. Reviewed at P3 exit and P6 exit ([roadmap](../roadmap.md)).
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
| T01 | Relay or network reads content | 1, 2 | Noise IKpsk2 E2E; relay parses only headers | property test: all relay-visible payload bytes are indistinguishable from random; relay code review: no payload access |
| T02 | Frames injected, modified, reordered | 1, 2 | AEAD with counter nonces; any failure closes the channel | tamper vectors; e2e with adversarial relay mode in testkit |
| T03 | Relay impersonates the host to the phone | 2 | host static key pinned from the QR (out-of-band) | pairing with a substituted responder key fails |
| T04 | Relay impersonates a phone to the host | 2 | device static key allowlist + `devicePsk` + relay source id check | handshake from unknown key or wrong PSK rejected silently |
| T05 | Replay of frames, prompts, approvals | 1, 2 | Noise nonces; `requestId` dedupe; approval id single-use + `issuedAt` ±5 min | replayed transport record closes channel; replayed answer → `already_resolved` |
| T06 | QR photographed and used to pair | 11 | SAS numeric comparison confirmed on the PC; ticket single-use 10 min; device name shown | pairing without PC confirmation never completes; second use of ticket → `410` |
| T07 | Strangers use the relay | 10 | host enrollment requires secret; device enrollment requires ticket; rate limits; endpoint cap; unknown routes 404 | relay tests for each |
| T08 | Relay/FCM outage | — | availability accepted as residual; PC keeps working; phone shows offline | — |
| T09 | Locked phone stolen | 4 | app lock; keys in Keystore/Tink; revoke from PC | manual device test; revoke e2e |
| T10 | Unlocked phone used to approve a dangerous action | 5 | high-risk approvals require a per-use biometric signature verified by the host; app re-locks after 5 min in background; no approve-from-notification | host rejects unsigned/invalid high-risk answers; UI test for re-lock |
| T11 | Phone malware extracts keys or overlays prompts | 6 | Keystore non-exportable approval key; Tink-wrapped keyset in app sandbox; `FLAG_SECURE`; BiometricPrompt is system UI | manual review checklist |
| T12 | Phone reads secrets on the PC via path tricks (`..`, junctions, symlinks, 8.3 names, UNC, `\\?\`) | 5, 6 | Policy Guard canonicalizes and confines reads to session root ∪ roots; denies device/UNC paths | path-escape test matrix on Windows and POSIX |
| T13 | Phone starts sessions in sensitive folders | 5 | roots allowlist; `allowRemoteSessionStart` switch | guard tests |
| T14 | Prompt injection leads to a dangerous approval approved on a small screen | 9 | exact command/args preview; risk classifier; biometric for high risk; `argsDigest` binds what was shown; answers need the app, not the notification | classifier unit tests; digest mismatch → refuse to sign |
| T15 | CSRF / DNS rebinding against the management page | 8 | page lives under dsh `/api` (cookie `SameSite=Strict`, Host/Origin fence); state changes are POST with same-origin checks | cross-origin POST rejected; rebinding Host rejected |
| T16 | Local users hit Remora | 7 | Remora opens no port; management page inherits dsh cookie auth; secrets in the user profile | port scan shows no new listener |
| T17 | Hostile git config executes code during `diffs.*` | 9 | `core.fsmonitor=false`, empty hooks path, `--no-ext-diff --no-textconv`, `--no-optional-locks`, timeouts | repo with malicious `core.fsmonitor`/`diff.external` does not execute |
| T18 | Push content visible to Google | 3 | payload encrypted with per-device push key; `host_offline` carries metadata only | FCM payload assertion in relay tests |
| T19 | Secrets or content in logs | all | redaction helpers; log statements reviewed; tests scan captured logs for known secrets and payload markers | log-scan tests in host, relay, app |
| T20 | Dependency supply chain | — | lockfiles committed; minimal dependencies; audited `@noble/*`, BouncyCastle, Tink; `pnpm audit` / Gradle dependency review in CI | CI job |
| T21 | A dsh upgrade silently routes approvals around the bridge | — | adapter fixtures per version; startup self-check that the bridge listener is registered and ordered first; CI against npm `next` | self-check test with mock waterfall |
| T22 | Protocol downgrade | 1, 2 | only v1 exists; `hello` negotiates max common version; relay rejects unknown versions | version tests |
| T23 | Paired device floods the host | 5, 6 | per-device rate limits, stream caps, 48 KiB messages | load tests |
| T24 | Clock manipulation to reuse an approval | 5 | single-use ids are primary; time window is secondary | replay with shifted clock rejected |
| T25 | Attacker who knows the phone PIN enrolls a new fingerprint | 5 | approval keys invalidated on biometric enrollment; rotation requires PC confirmation | device test |
| T26 | Leaked relay enroll secret | 10 | only enables host enrollment; hosts cannot reach unlinked devices; rotate secret | link-scoping tests |
| T27 | Cloudflare account takeover | 2 | same as ADV2 (content-blind) + junk pushes fail decryption; owner enables 2FA | undecryptable push is dropped |
| T28 | Stolen relay key used to kick the real device (newest wins) | 6 | relay key alone cannot pass E2E; repeated 4409 surfaces a warning in the app | reconnect-storm test |

## 4. Residual risks (accepted for v1)

- The relay operator and Google learn metadata: endpoint ids, connection times, message sizes and counts, push timing.
- Availability depends on Cloudflare and FCM.
- A user can still approve a malicious action shown accurately in the preview.
- No host key rotation without re-pairing.
- Attestation of the approval key is recorded but not enforced in v1.

## 5. Security test checklist (P3-T1, P6-T2)

- [ ] Cacophony + Remora Noise vectors pass in TypeScript and Kotlin; cross-implementation handshake in CI.
- [ ] Adversarial relay mode in `@remora/testkit` (flip bits, reorder, replay, drop, splice channels) → channel closes, no plaintext accepted.
- [ ] Pairing: missing SAS confirmation, ticket reuse, expired QR, substituted host key, wrong PSK.
- [ ] Approvals: unsigned high-risk, bad signature, high-S DER accepted, digest mismatch, replay, cross-session id, after revoke.
- [ ] Path escapes: `..`, absolute outside roots, junction, symlink, 8.3 short name, UNC, `\\?\`, mixed case, trailing dots/spaces (Windows), NUL bytes.
- [ ] Git hardening with hostile repo config.
- [ ] Log scans (host, relay `wrangler tail` capture, app diagnostics export) contain no secrets or payload markers.
- [ ] Management page: cross-origin POST, rebinding Host, missing cookie.
- [ ] Rate limits and size limits at relay and host.
- [ ] Revocation: immediate at host, relay socket closed, FCM token cleared, re-enroll impossible without new ticket.
