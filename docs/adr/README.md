# Architecture Decision Records

One file per decision, numbered, never rewritten after acceptance. To change a decision, add a new ADR that supersedes the old one and update the old one's status line only.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-out-of-tree-dsh-bundle.md) | Extend dsh with an out-of-tree bundle, never a fork | Accepted |
| [0002](0002-cloudflare-e2e-relay.md) | Self-hosted content-blind relay on Cloudflare Workers + Durable Objects | Accepted |
| [0003](0003-rcp-anti-corruption-layer.md) | RCP/1 as an anti-corruption layer over dsh's Remote API | Accepted |
| [0004](0004-noise-ikpsk2-secure-channel.md) | Noise IKpsk2 secure channel with QR + SAS pairing | Accepted |
| [0005](0005-native-android-client.md) | Native Android client (Kotlin, Compose, multi-module) | Accepted |
| [0006](0006-fcm-push-via-relay.md) | FCM data pushes sent by the relay with E2E-encrypted payloads | Accepted |
| [0007](0007-biometric-gated-parity.md) | Capability parity gated by biometric signatures and a folder allowlist | Accepted |
| [0008](0008-answer-bridge-race.md) | AnswerBridge races phone and PC GUI for approvals and questions | Accepted (mechanism details pending P0-S2) |
| [0009](0009-always-on-host.md) | Always-on host via per-user logon supervisor and keep-awake | Accepted (mechanism details pending P0-S6) |
| [0010](0010-monorepo-toolchain.md) | One monorepo: pnpm TypeScript workspace + Gradle Android + shared vectors | Accepted |

Template:

```markdown
# ADR-NNNN: Title
- Status: Proposed | Accepted | Superseded by ADR-XXXX
- Date: YYYY-MM-DD
- Deciders: <roles>
## Context
## Decision
## Consequences
## Alternatives considered
```
