# Handoff: P7-A8 — Host streams required by Android foreground composition

- **Role:** Host, Integrator-assigned follow-up
- **Agent:** Codex
- **Date:** 2026-10-05
- **Branch:** `codex/approval-parity` (separate host commit after Android changes)

## Implementation

The workspace adapter opens the live iterator without waiting for it to end, so
RCP can return a stream ID. Baselines replace cached workspaces; upserts and
removals maintain the set. Invalid/delivery failures end the stream with a
content-free error instead of hanging or reporting successful completion.

Session control retains complete queue/jobs state across upstream replacements,
collects all queued text blocks, and reads running state from actual live dsh
Agents. A typed adapter helper supplies initial state plus Agent status and
Session creation/disposal events. Its listeners are disposed by Cordis and
stream cancellation. Pending replacements coalesce per session with a bounded
map; large/unavailable deliveries fail the stream rather than drop updates.

`packages/host/src/index.ts` passes the adapter-owned activity source. All new
dsh-specific shape knowledge remains under `src/adapter`. README and upstream
integration notes describe the seams. The existing finite workspace test fixture
now awaits the asynchronously delivered baseline and supplies stream termination.

## Source evidence and deferred verification

`git -C C:\Users\olsis\Desktop\lotoss\ds\.upstream\deepseek-harness rev-parse --short HEAD`
returned `a4c74a9`, matching the pinned upstream commit. Read the actual workspace
feed, session control types/producer, session list, Agent registry, and dsh event
declarations. No upstream source or owner dsh profile was changed.

**No build, test suite, security suite, real-dsh run, or CI job was executed.**
The user explicitly requested implementation first and deferred tests/gates.
`git diff --check` produced no output before documentation was added; this is
only a whitespace check, not runtime or independent verification.

## Required later evidence

- [ ] Real Cordis/host stream-open response arrives while dsh generator remains open.
- [ ] Workspace baseline, upsert/removal, reconnect replacement, cancel and error paths.
- [ ] Real queue/jobs replacements preserve the untouched component.
- [ ] Running status changes and session disposal reach an already open control stream.
- [ ] Cancellation removes listeners and upstream generators within the disposal budget.
- [ ] Typecheck/lint/unit/e2e and independent review under the ordinary project gates.

No P7 task acceptance, phase exit, hosted behavior, or phone workflow is claimed.
