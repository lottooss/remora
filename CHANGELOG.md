# Changelog

All notable changes to the Remora remote control suite will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] — 2026-09-27

### Initial Release

Remora provides secure, end-to-end encrypted remote control of the DeepSeek Harness (`dsh`) running on a Windows PC from an Android mobile application through a self-hosted Cloudflare Worker relay.

#### Protocols & Cryptography
- **RCP/1 (Remora Control Protocol):** Strict, bounded RPC and bidirectional streaming protocol over Noise channels.
- **RLY/1 (Relay Protocol):** Framed binary multiplexing protocol over WebSocket with blind 28-byte headers.
- **Crypto/1:** Noise IKpsk2 mutual authentication with Curve25519, ChaCha20-Poly1305 AEAD, BLAKE2s, and SHA-256.
- **Biometric Approvals:** ECDSA P-256 with SHA-256 per-use biometric signatures in Android Keystore, verified by host Policy Guard.
- **Encrypted Push Notifications:** Per-device ChaCha20-Poly1305 authenticated encryption preventing metadata leakage to FCM.

#### Host & PC Integration (`@remora/host`, `@remora/cli`)
- Zero listening sockets: Outbound-only TLS connection (`wss://`) to the self-hosted relay.
- DeepSeek Harness Cordis plugin integrating cleanly without touching upstream `@deepseek-ai/*` packages.
- Policy Guard enforcing roots containment, canonical Windows path resolution, and risk classification.
- Interactive Answer Bridge intercepting questions, tool approvals, and command executions.
- Workspaces, file browsing, and hardened Git status / diff viewing with hunk pagination.
- Windows Task Scheduler logon service supervisor (`remora service install/status/logs/uninstall`).
- Windows sleep-prevention execution state (`ES_SYSTEM_REQUIRED`) during active AI agent turns.

#### Relay (`@remora/relay`)
- Cloudflare Workers + Durable Object (`AccountHub`) architecture.
- Real-time blind frame routing with token-bucket rate limiting (50 frames/s, burst 100).
- Encrypted FCM push dispatch with scheduled host-offline alarms upon missed heartbeats.
- Persistent SQLite storage for endpoint links, tickets, and push tokens.

#### Android Application (`apps/android`)
- Native Jetpack Compose UI with Material 3 styling and dark mode.
- QR code pairing with Short Authentication String (SAS) numeric comparison.
- Real-time conversation streaming with syntax-highlighted markdown and interactive tool execution blocks.
- Workspace file tree browser and unified git diff viewer.
- Biometric prompt authentication for high-risk tool and command approvals.
- FCM push notification routing with deep links to active sessions and pending approvals.

#### Verification & Reliability
- 100% pass rate across 9 performance and resilience benchmarks (`tests/perf`):
  - Prompt tap to host ACK: p50 = 14 ms (target ≤ 400 ms)
  - Assistant chunk to stream frame: p50 = 158 ms (target ≤ 350 ms)
  - 100 socket flaps during active streaming with 0 lost or duplicated events
  - Zero memory growth over 1,000 streaming iterations
  - Daily relay usage projected at 8.3% of Cloudflare free tier quota
- 100% pass rate across 39 security tests (`tests/security`):
  - Adversarial relay frame tampering, splicing, and replay mitigation
  - Windows path escape defense (junctions, 8.3 names, UNC, device namespaces)
  - Malicious repository git hooks and config isolation
  - Zero secrets in logs, diagnostics, or telemetry
- Comprehensive conformance test vectors shared across TypeScript and Kotlin.
