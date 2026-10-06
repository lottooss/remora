# Handoff: P7-A8 — Host handshake and status schema alignment

- **Role:** Host, Integrator-assigned follow-up
- **Agent:** Codex
- **Date:** 2026-10-05
- **Branch:** `codex/approval-parity`, separate follow-up commit

## Implementation

`hello` now validates the existing `HelloParamsSchema`, requires the client to
offer RCP/1, and returns `HelloResultSchema`: scalar `rcp`, host platform/path
separator/versions, valid capability names, canonical roots, actual policy,
enforced size/stream limits and host clock. Malformed requests fail with
`invalid_params`; missing/invalid runtime metadata fails closed.

`host.status` returns the existing schema's uptime, running-agent count,
keep-awake acquisition state, and dsh version/profile. `RcpServerOptions` accepts
`runtimeProvider: HostRuntimeProvider` with `hello()` and `status()` methods.
Standalone servers without that provider can serve unrelated methods but cannot
invent successful hello/status responses. The removed `statusProvider` API was
an internal host option, not the shared protocol.

Production passes a provider from `adapter/runtime.ts`, reads Remora's own
package manifest, and declares the `agents`/`sessions` injection dependencies.
dsh version comes from the actual running CLI's package manifest; profile comes
from the actual root Cordis profile URL with profile-manifest validation. Live
Agent count uses the real registry, regardless of keep-awake configuration.

Testkit's real RPC caller offers the supported RCP version, sends the schema's
fixed `remora-testkit` app identity, and validates hello/status responses. Its
legacy display-name parameter is retained for source compatibility but is not
sent as a wire app identity. Ordinary host/testkit/e2e/perf fixtures now provide
explicit fake runtime metadata where needed. Relay connectivity and device-count
assertions remain checks against the real fixture objects, since those fields
are not part of `host.status`. No checks were skipped or weakened and no
`tests/real-dsh` file was changed.

## Source evidence and deferred verification

Read the pinned upstream CLI `bin.ts`, `profile-boot.ts`, app-boot `boot` and
profile loader, Cordis root-context implementation, and Agent registry. Some
files excluded from the sparse working tree were read with `git show HEAD:path`.
The verified source seams are recorded in `docs/upstream/dsh-integration.md` §9.4.

**No build, test suite, CI job, or real-dsh/phone run was executed**, following the
user's implementation-first instruction. `git diff --check` is whitespace-only
source inspection. No green-gate, acceptance, or runtime-success claim is made.

## Remaining verification/limits

- [ ] Typecheck, lint, host/testkit unit and affected e2e/perf suites.
- [ ] Negative hello offers/malformed provider results and strict Android parsing.
- [ ] Real dsh CLI launch, including symlinked npm binary, reports actual metadata.
- [ ] Actual running/idle Agent count and keep-awake transitions.
- [ ] Non-CLI/packaged launchers need a verified alternative metadata seam; they
  intentionally fail metadata calls rather than report a guessed profile/version.

The frozen Crypto/1 body versus existing five-line/JCS approval implementation
discrepancy recorded in `P7-A8-approval-parity.md` remains pending a coordinated
Integrator contract decision. This follow-up makes no crypto or wire change.
