# ADR-0008: AnswerBridge races phone and PC GUI for approvals and questions

- Status: Accepted — withdrawal mechanism finalized by P0-S2 (derived AbortSignal substitution; `approval/decided` is not a withdrawal path)
- Date: 2026-09-24
- Deciders: Integrator, Host

## Context

In dsh `0.1.5-rc.3`, `approval/request` and `user-questions/request` are Agent-scoped Cordis waterfalls. The web app's `api-remotes` registers one listener per connected browser stream and forwards the request to that browser; a browser either answers or delegates with `next()`.

**Observed (P0-S2, 0.1.5-rc.3):**

- With **zero** remote-event clients, `next()` does **not** settle with the terminal `unavailable` default; the gateway creates a pending event with zero deliveries and **parks** until an answer, cancel, or abort. A self-check waterfall that registers its own terminal still gets immediate `unavailable`.
- With a connected but **passive** browser, the PC receives the card and `next()` also parks (no auto-answer).
- `ApprovalService.decide()` races the waterfall against the request's abort signal. `approval/decided` is **not** forwarded to remote-event clients (`API_REMOTE_FORWARDED_EVENTS`); observing it does not clear a browser card.
- A derived `AbortSignal` substituted on the request passed into `next()` **does** produce a gateway `cancel` frame to the browser and rejects the PC chain promptly without aborting the parent turn.

Consequences for a naive design: a phone registered as "one more client" is ordered behind open browser tabs; with no tab open the request hangs rather than failing closed unless someone answers or the turn is cancelled.

## Decision

- Remora registers one listener per event on the root context with `prepend: true`.
- For each request it creates a pending item (Remora `approvalId`, preview looked up from the session log by `callId`, `argsDigest`, risk), publishes it to devices, pushes a notification, and **races**: first valid phone answer, `next()` (PC GUI chain), the request signal, and `approvalTimeoutMs`.
- The bridge must bound `next()` (timeout / cancellation); do not assume a terminal default fires on zero clients.
- If `next()` yields `unavailable` / `NO_PROVIDER` / a bridge withdrawal error while at least one device is paired, the bridge keeps waiting for the phone until `approvalTimeoutMs`.
- The first valid answer is returned; the losing side is withdrawn. For the PC chain, P0-S2 selected **substituting a derived `AbortSignal` on the request passed to `next()`**: aborting the derived signal cancels the browser card via `cancelRemoteEvent` without aborting the parent turn. Do not rely on `approval/decided` for UI withdrawal.
- With no device paired, the bridge delegates transparently (`return next()`), so dsh behaves exactly as without Remora (modulo zero-client parking).

## Consequences

- The PC GUI and the phone both work at the same time; being away from the PC no longer fails approvals.
- Turns can wait up to `approvalTimeoutMs` (default 1 h) for a phone answer — intended; cancel from either side ends the wait.
- Depends on Cordis waterfall ordering with `prepend`; a startup self-check verifies the bridge is first, and a dsh upgrade that breaks this fails CI (threat T21).
- Stale-card risk if signal substitution cannot be applied — document as residual; optional upstream proposal to forward `approval/decided` or settle zero-client pending events.

## Alternatives considered

- **Phone as another `api-remotes` client:** ordered behind browsers; fails or hangs with none. Rejected.
- **Presence-based routing only** (PC idle time decides who answers): guesses wrong when a tab is left open. Rejected as primary; may complement.
- **Observe `approval/decided` to clear the PC card:** event not delivered to remote clients; stale card confirmed (P0-S2 E3b). Rejected as withdrawal mechanism.
- **Nothing (leave PC chain hanging):** PC-chain timeout + stale card (P0-S2 E3c). Rejected.
- **Upstream change first:** slower and not under our control; proposed in parallel.
