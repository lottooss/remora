# ADR-0007: Capability parity gated by biometric signatures and a folder allowlist

- Status: Accepted
- Date: 2026-09-24
- Deciders: Owner, Integrator, Verification

## Context

The owner wants the phone to do what the PC GUI can do, with safety gates: an unlocked stolen phone, a rushed approval on a small screen, or a prompt-injected agent asking for something dangerous must not become easy remote code execution on the PC.

## Decision

- **Parity:** the phone uses the same dsh permission presets and approval policy as the PC.
- **Gates enforced by the host (Policy Guard), not by UI alone:**
  - Phone-initiated browse, workspace creation, and session start are confined to canonicalized `remoteRoots`; file reads to the session root ∪ roots.
  - A deterministic risk classifier marks approvals `normal` or `high` (sandbox escalation, writes outside the workspace, unknown tools, destructive command patterns, permission changes → `high`).
  - `high` approvals (or all, with `approvalBiometric: all`) require an ECDSA P-256 signature from a Keystore key that needs a fresh `BIOMETRIC_STRONG` authentication per use, over a message that binds host, device, approval, session, call, tool, preview digest, outcome, and time ([Crypto/1 §7](../specs/crypto-v1.md#7-approval-signatures)).
  - App lock on start and after 5 minutes in background; no actions on notifications; `FLAG_SECURE` on sensitive screens.
  - Devices are revocable from the PC instantly.
- Devices without strong biometrics may use device-credential authentication when the owner opts in on the PC (`approvalAuth: biometric-or-credential`), recorded per device.

## Consequences

- A thief with an unlocked phone cannot pass high-risk approvals; a thief with a locked phone gets nothing.
- The classifier is heuristic; unknown tools default to `high`, which errs toward more fingerprint prompts.
- Changing biometric enrollment invalidates the approval key; re-keying needs PC confirmation.

## Alternatives considered

- **Restricted remote mode** (safer preset forced for remote work): offered to the owner, not chosen.
- **Full parity without gates:** offered to the owner, not chosen.
