# ADR-0003: RCP/1 as an anti-corruption layer over dsh's Remote API

- Status: Accepted
- Date: 2026-09-24
- Deciders: Integrator, Host, Android

## Context

The web GUI talks to dsh through Typert-generated Remote contracts (unary calls, journal/snapshot streams with cursors, forwarded events, agent-scoped waterfalls). Those contracts are TypeScript-generated, pre-stable, and shaped for a same-version browser client. The phone is a native Kotlin app that ships on its own cadence and needs compact, bounded, resumable messages over a high-latency link.

In-process, the Host exposes the same dispatch as `ctx.typertGateway.invoke({ namespace, method, args, signal })` and `ctx.typertGateway.stream(...)`, applying strict validation and the Session Controller's lookup policy (live-agent reuse, cold resume, subagent fence).

## Decision

- The phone speaks only **RCP/1** ([spec](../specs/rcp-v1.md)).
- The host's **DshAdapter** implements RCP by calling the gateway in-process and by listening to Cordis events; approvals and questions go through the AnswerBridge (ADR-0008).
- Only `packages/host/src/adapter/**` and `packages/host/src/interaction/dsh-*.ts` may import `@deepseek-ai/*` types or name dsh endpoints and events. The adapter maps dsh errors and events into RCP vocabularies and preserves unknown dsh event types as `unknown`.
- Each supported dsh version has recorded follow fixtures; mapper tests run against all of them.

## Consequences

- dsh upgrades touch one directory; the phone contract stays stable.
- RCP is a second vocabulary to maintain; mapping bugs are caught by fixtures and e2e tests.
- Phone-oriented features (truncation, coalescing, paging, idempotency keys, size limits) live in one place.

## Alternatives considered

- **Tunnel dsh's own Remote wire protocol to the phone:** the Kotlin app would reimplement Typert codecs, journal streams, gap repair, and waterfall semantics, and break on every upstream change. Rejected.
- **Call Host services directly (e.g. `ctx.sessionController.prompt`) instead of the gateway:** skips lookup resolution and validation that the gateway guarantees for the web GUI and couples Remora to service internals. Allowed only where the gateway exposes no endpoint, documented per use.
- **SDK profile:** see ADR-0001.
