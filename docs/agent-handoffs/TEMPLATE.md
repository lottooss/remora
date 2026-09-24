# Handoff: <TASK_ID> — <title>

- **Role:** <integrator | protocol-crypto | relay | host | android | verification>
- **Agent:** <Claude Code / Codex / Gemini / dsh / human> (<model if known>)
- **Date:** <ISO-8601>
- **Branch / PR:** `task/<id>-<slug>` / #<n>
- **Commit:** <sha>

## Summary

<2–5 sentences: what exists now that did not before.>

## Changed paths

- `path/one`
- `path/two`

## Verification

| Command | Result |
|---|---|
| `pnpm -F @remora/<pkg> test` | ✅ 42 passed |
| `./gradlew :core:crypto:test` | ✅ 118 passed |

<Paste relevant output excerpts, screenshots for UI, device model for on-phone checks.>

## Acceptance criteria

- [x] <copied from the packet, each with evidence or a link>

## Deviations from the packet

<None, or what changed and why (with Integrator approval link).>

## Known limitations / follow-ups

- <issue links for anything deferred>

## Unblocks

- <task ids>
