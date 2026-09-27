# Open-Source License Inventory

- **Task:** [P6-T2](../tasks/P6-T2.md) — Threat-model review, dependency audit, hardening
- **Role:** verification
- **Date:** 2026-09-27
- **Scope:** Remora TypeScript workspaces (`@remora/*`, `apps/relay`, `apps/cli`) and Android Application (`apps/android`).

---

## 1. Summary

All production and runtime dependencies in Remora are licensed under permissive open-source licenses:
- **MIT License**
- **Apache License 2.0**
- **BSD 3-Clause License**
- **ISC License**

No copyleft (GPL, AGPL) or viral commercial licenses are present in any production artifact or build bundle.

---

## 2. TypeScript Workspaces (Production Runtime Dependencies)

| Package | Version | License | Upstream Repository | Purpose |
|---|---|---|---|---|
| `@noble/ciphers` | `^2.4.0` | MIT | [paulmillr/noble-ciphers](https://github.com/paulmillr/noble-ciphers) | ChaCha20-Poly1305 AEAD cipher implementation |
| `@noble/curves` | `^2.4.0` | MIT | [paulmillr/noble-curves](https://github.com/paulmillr/noble-curves) | X25519, Ed25519, and Secp256r1 curve operations |
| `@noble/hashes` | `^2.4.0` | MIT | [paulmillr/noble-hashes](https://github.com/paulmillr/noble-hashes) | SHA-256, BLAKE2s, HMAC, and HKDF primitives |
| `ws` | `^8.18.0` | MIT | [websockets/ws](https://github.com/websockets/ws) | WebSocket client for Node.js host and test harness |
| `zod` | `^3.24.0` | MIT | [colinhacks/zod](https://github.com/colinhacks/zod) | Runtime protocol schema validation |
| `qrcode` | `^1.5.4` | MIT | [soldair/node-qrcode](https://github.com/soldair/node-qrcode) | Terminal and data-URI QR generation for pairing |
| `commander` | `^13.0.0` | MIT | [tj/commander.js](https://github.com/tj/commander.js) | CLI arguments parsing in `apps/cli` |

---

## 3. Android Application Runtime Dependencies

| Library Artifact | Coordinates | License | Purpose |
|---|---|---|---|
| AndroidX Core & KTX | `androidx.core:core-ktx:1.15.0` | Apache-2.0 | Core Android extensions |
| AndroidX Lifecycle | `androidx.lifecycle:lifecycle-*:2.8.7` | Apache-2.0 | ViewModel and Coroutine state flows |
| AndroidX Biometric | `androidx.biometric:biometric:1.2.0-alpha05` | Apache-2.0 | BiometricPrompt authentication |
| AndroidX Security Crypto | `androidx.security:security-crypto:1.1.0-alpha06` | Apache-2.0 | EncryptedSharedPreferences and Tink integration |
| Google Tink | `com.google.crypto.tink:tink-android:1.16.0` | Apache-2.0 | Android Keystore authenticated key wrapping |
| BouncyCastle | `org.bouncycastle:bcprov-jdk18on:1.80` | Bouncy Castle (MIT-like) | X25519, ChaCha20-Poly1305, HKDF primitives |
| Firebase Cloud Messaging | `com.google.firebase:firebase-messaging:24.1.0` | Apache-2.0 | High-priority push wakeups and device tokens |
| Jetpack Compose | `androidx.compose.*:2024.12.01` (BOM) | Apache-2.0 | Declarative UI framework |
| Kotlinx Coroutines | `org.jetbrains.kotlinx:kotlinx-coroutines-*:1.10.1` | Apache-2.0 | Asynchronous structured concurrency |
| Kotlinx Serialization | `org.jetbrains.kotlinx:kotlinx-serialization-*:1.8.0` | Apache-2.0 | Type-safe JSON serialization |
| OkHttp | `com.squareup.okhttp3:okhttp:4.12.0` | Apache-2.0 | Outbound WebSocket connection to relay |
| Dagger Hilt | `com.google.dagger:hilt-android:2.55` | Apache-2.0 | Dependency injection |

---

## 4. Verification and Lockfiles

1. **Node.js dependencies:** Locked via root `pnpm-lock.yaml`. Audited with `pnpm audit --prod` (0 vulnerabilities).
2. **Android dependencies:** Locked via Gradle dependency graph. Audited via `gradlew app:dependencies --configuration releaseRuntimeClasspath` with Google Maven and Maven Central repositories only.
3. **Crypto pinning:** `@noble/*` (v2.4.0) and BouncyCastle (v1.80) are pinned to immutable releases verified against upstream release tags.
