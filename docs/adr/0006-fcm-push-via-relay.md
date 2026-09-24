# ADR-0006: FCM data pushes sent by the relay with E2E-encrypted payloads

- Status: Accepted
- Date: 2026-09-24
- Deciders: Integrator, Relay, Android, Host

## Context

The phone must learn about approvals, questions, finished or failed turns, and an offline PC without keeping a socket open in the background (battery, Android background limits). The relay is always online and can observe when a host disappears.

## Decision

- The relay holds the FCM service-account secret and calls FCM HTTP v1 with **data-only** messages.
- The host encrypts each notification per device with the device's push key (ChaCha20-Poly1305, [Crypto/1 §8](../specs/crypto-v1.md#8-push-payload-encryption)); the relay forwards ciphertext it cannot read.
- The relay itself generates `host_offline` alerts from a Durable Object alarm; those carry metadata only.
- The app decrypts in `FirebaseMessagingService`, renders a local notification in the right channel, and deep-links; notifications have no approve/reject actions.

## Consequences

- No background socket; low battery cost.
- Requires Google Play services and a Firebase project created by the owner (`google-services.json` stays out of git).
- Google learns push timing and sizes; content stays encrypted.

## Alternatives considered

- **Host calls FCM directly:** the PC would hold Google credentials and could not report its own absence. Rejected.
- **UnifiedPush / ntfy:** avoids Google but needs a distributor app and is less reliable on some OEMs. Deferred; the Notifier keeps a provider interface so it can be added.
- **Foreground service with a persistent socket:** battery cost and Android restrictions. Rejected.
