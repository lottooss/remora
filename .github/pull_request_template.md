## Summary

<!-- What changed and why, in 2–5 sentences. -->

## Task

<!-- `<TASK_ID>` — link the packet in docs/tasks/ — Closes #<issue> -->

## Changes

- 

## Verification

<!-- Exact commands and their results (paste real output excerpts). -->

| Command | Result |
|---|---|
|  |  |

## Risks and follow-ups

<!-- Security-sensitive areas touched (crypto, policy, interaction, relay routing)? Invariants in AGENTS.md §1 affected? -->

## Checklist

- [ ] Only the packet's `owned_paths` changed (plus the handoff report)
- [ ] AGENTS.md §8 gates for every touched area pass
- [ ] Docs updated (package README, spec if wire-visible, `docs/upstream/dsh-integration.md` if a dsh seam was used)
- [ ] Handoff report at `docs/agent-handoffs/<TASK_ID>.md`
- [ ] No secrets, real keys, or payload content in code, logs, fixtures, or screenshots
