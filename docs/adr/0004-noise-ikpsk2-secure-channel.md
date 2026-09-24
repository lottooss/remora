# ADR-0004: Noise IKpsk2 secure channel with QR + SAS pairing

- Status: Accepted
- Date: 2026-09-24
- Deciders: Integrator, Protocol & Crypto, Verification

## Context

Traffic crosses an untrusted relay (ADR-0002). We need mutual authentication, forward secrecy, a one-round-trip handshake, an out-of-band pairing step that works by scanning the PC screen, and interoperable implementations in TypeScript (host) and Kotlin (phone).

## Decision

- `Noise_IKpsk2_25519_ChaChaPoly_SHA256`, device = initiator, host = responder, prologue binding purpose and both endpoint ids ([Crypto/1 §6](../specs/crypto-v1.md#6-secure-channel-sc1)).
- Pairing: the QR carries the host static key, a relay ticket, and a 32-byte pairing secret (→ PSK); both sides show a 6-digit SAS derived from the handshake hash; the owner confirms on the PC. The host then issues a per-device PSK and push key.
- Implementations are small, own code over audited primitives (`@noble/*` in TypeScript, BouncyCastle in Kotlin), validated by the official Cacophony vectors, Remora-specific vectors, and a cross-language handshake test in CI.

## Consequences

- Well-studied pattern (WireGuard uses IKpsk2); the PSK adds a symmetric layer on top of X25519.
- Two handshake implementations to maintain; conformance vectors are mandatory gates.
- Noise's 65,535-byte message limit sets RCP's 48 KiB message ceiling; large content is paged, not chunked.

## Alternatives considered

- **TLS with pinned self-signed certificates through the relay:** heavy on both platforms, no PSK, awkward certificate lifecycle. Rejected.
- **libsodium `crypto_kx` + `secretstream`:** no standard authenticated handshake; forward secrecy would need a custom design. Rejected.
- **Signal/MLS:** built for asynchronous group messaging; far more machinery than a two-party live channel needs. Rejected.
- **Existing Noise libraries:** the maintained options do not cover both runtimes consistently; a ~400-line implementation per language with vectors is easier to audit than an unmaintained dependency.
