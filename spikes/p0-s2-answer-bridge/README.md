# P0-S2 — AnswerBridge race spike

Throwaway bundle that answers Q5–Q7 for [ADR-0008](../../docs/adr/0008-answer-bridge-race.md):

- root-context `prepend: true` listeners for `approval/request` and `user-questions/request`
- control routes under `/api/remora/s2/*`
- a scripted `/api/remote.mux` browser client
- a mock-LLM experiment runner (each experiment twice)

Not part of the pnpm workspace. Findings go to `docs/spikes/P0-S2.md`.

## Setup (once)

```sh
node scripts/setup.mjs
```

Installs `@deepseek-ai/dsh@0.1.5-rc.3` into `.install/`, creates `~/.dsh/profiles/remora-dev` from the `web` template, and `dsh plugin add`s this directory.

## Run experiments

```sh
node scripts/run-experiments.mjs
node scripts/run-experiments.mjs --only e3
```

Evidence lands in `out/runs/<experiment>-pass<n>/`:

| File | Contents |
|---|---|
| `summary.json` | drive result, dsh stdout/stderr slice, browser output |
| `control-log.json` | plugin JSONL (`events.jsonl` via `/api/remora/s2/log`) |
| `events.jsonl` | same JSONL written by the plugin under `outDir` |
| `browser.jsonl` | scripted client frames (waterfall / cancel / answer posts) |

## Manual control

With dsh running:

```sh
curl -s http://127.0.0.1:7718/api/remora/s2/config
curl -s -X POST http://127.0.0.1:7718/api/remora/s2/config \
  -H 'content-type: application/json' \
  -d '{"mode":"answer-first","withdrawal":"signal"}'
curl -s http://127.0.0.1:7718/api/remora/s2/log
curl -s -X POST http://127.0.0.1:7718/api/remora/s2/scenario \
  -H 'content-type: application/json' -d '{"scenario":"selfcheck"}'
```

## Modes

| `mode` | Behavior |
|---|---|
| `observe` | log entry, `await next()`, log resolution (experiments 1, 2, 4, 5, 6) |
| `answer-first` | claim decision immediately; optionally substitute `AbortSignal.any` on the shared request before `next()` (experiment 3) |
| `race-next` | fire `next()` and a delayed phone answer; first wins |
| `defer` | same as observe (placeholder for a control-plane answer) |

| `withdrawal` | Only with `answer-first` |
|---|---|
| `signal` | replace `req.signal` with `AbortSignal.any([original, withdraw])` then abort after `next()` starts |
| `decided-observe` | claim first, do not touch the signal; note expects a stale card |
| `none` | claim first, do nothing to the PC chain |
