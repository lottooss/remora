# Task packets

A task packet is the complete work order for one agent session (or a few). Packets in this directory are the **source of truth**; GitHub issues mirror them and are created or updated with:

```sh
node scripts/sync-issues.mjs --dry-run   # preview
node scripts/sync-issues.mjs             # create/update milestones, labels, issues (needs gh auth)
```

## Format

```markdown
---
id: P1-H1                       # phase + area letter + number; stable forever
title: "Host plugin foundation"  # issue title becomes "P1-H1 · Host plugin foundation"
phase: P1                        # → milestone
role: host                       # integrator | protocol-crypto | relay | host | android | verification
kind: feature                    # spike | feature | chore | test | docs
size: L                          # S ≤ 1 day · M 2–3 days · L 4–6 days (agent-days, rough)
depends_on: [P0-S1, P1-P1]
owned_paths:                     # the only paths this task may modify (plus its handoff report)
  - packages/host/**
---

## Goal            one paragraph: the outcome, not the steps
## Inputs          specs, ADRs, upstream files, fixtures to read first
## Deliverables    files, packages, docs
## Acceptance      checkboxes; each is observable and testable
## Constraints     invariants and scope limits specific to this task
## Stop and report conditions that require the Integrator
## Verify          exact commands that must pass before the PR
```

## Lifecycle

1. **Ready** — all `depends_on` merged; inputs exist; the issue is unassigned.
2. **Claimed** — assign the issue to yourself (or comment `claimed by <agent>`), create branch `task/<id>-<slug>`.
3. **In review** — PR titled `<id>: <summary>`, body uses the PR template, handoff report committed at `docs/agent-handoffs/<id>.md`.
4. **Done** — CI green, reviewer (another role or the owner) approves, merged; the issue closes via `Closes #<n>` in the PR.

A task that discovers work outside its `owned_paths` stops and reports (see [AGENTS.md §5](../../AGENTS.md#5-working-a-task)). Split follow-ups into new packets (next free number in the phase) — never expand a packet silently.
