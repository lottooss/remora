# ADR-0008: AnswerBridge races phone and PC GUI for approvals and questions

- Status: Accepted — withdrawal mechanism pending P0-S2
- Date: 2026-09-24
- Deciders: Integrator, Host

## Context

In dsh `0.1.5-rc.3`, `approval/request` and `user-questions/request` are Agent-scoped Cordis waterfalls. The web app's `api-remotes` registers one listener per connected browser stream and forwards the request to that browser; a browser either answers or delegates with `next()`. With no browser connected the chain falls through to the terminal default: approvals resolve `unavailable` (the tool fails closed) and questions reject with `NO_PROVIDER`. `ApprovalService.decide()` races the waterfall against the request's abort signal. A deployment is expected to compose one terminal answerer.

Consequences for a naive design: a phone registered as "one more client" is ordered behind open browser tabs and never sees the request; with no tab open, the request fails before the phone can answer.

## Decision

- Remora registers one listener per event on the root context with `prepend: true`.
- For each request it creates a pending item (Remora `approvalId`, preview looked up from the session log by `callId`, `argsDigest`, risk), publishes it to devices, pushes a notification, and **races**: first valid phone answer, `next()` (PC GUI chain), the request signal, and `approvalTimeoutMs`.
- If `next()` yields `unavailable` / `NO_PROVIDER` while at least one device is paired, the bridge ignores it and keeps waiting.
- The first valid answer is returned; the losing side is withdrawn (devices get `resolved{by}`; for the PC chain, P0-S2 selects the mechanism in this order of preference: derived abort signal for the downstream chain → PC GUI observes `approval/decided` → documented stale-card limitation plus an upstream proposal for a multi-surface answerer).
- With no device paired, the bridge delegates transparently (`return next()`), so dsh behaves exactly as without Remora.

## Consequences

- The PC GUI and the phone both work at the same time; being away from the PC no longer fails approvals.
- Turns can wait up to `approvalTimeoutMs` (default 1 h) for a phone answer — intended; cancel from either side ends the wait.
- Depends on Cordis waterfall ordering with `prepend`; a startup self-check verifies the bridge is first, and a dsh upgrade that breaks this fails CI (threat T21).

## Alternatives considered

- **Phone as another `api-remotes` client:** ordered behind browsers; fails with none. Rejected.
- **Presence-based routing only** (PC idle time decides who answers): guesses wrong when a tab is left open. Rejected as primary; may complement.
- **Upstream change first:** slower and not under our control; proposed in parallel.
