# P6-T1 Performance & Reliability Benchmark Suite

Measures Remora against the success criteria in [blueprint §2.3](../../docs/blueprint.md#23-success-criteria-measured-in-p6).
Runs the **real relay** (`wrangler dev` via `@remora/testkit`'s `E2eEnvironment`) with a scripted
in-process dsh gateway and a TypeScript fake phone (`FakeDevice`), so results are deterministic
and need no external network, API keys, or physical devices.

## Layout

| File | What it measures |
|---|---|
| `vitest.config.ts` | Vitest config: workspace source aliases, `--expose-gc` (memory test), single worker, 240 s timeout |
| `network-resilience.spec.ts` | 100 socket disconnects during streaming, mid-stream disconnect + resume, cold recovery after host restart |
| `latency-and-scale.spec.ts` | Prompt→ACK latency, chunk→frame latency, 10k-event scale, memory growth, relay projection, approval→push latency |

## Prerequisites

- Node ≥ 24, pnpm (the repo pins both).
- `pnpm install` at the repo root (workspace packages must be linked).
- `pnpm run build` once, so `@remora/host` and friends resolve (the config aliases to `src/`, so a build is **not** strictly required, but the e2e environment loads the host bundle path).

## Run

```sh
# whole suite (both spec files)
pnpm test:perf

# one file
npx vitest run --config tests/perf/vitest.config.ts tests/perf/network-resilience.spec.ts
npx vitest run --config tests/perf/vitest.config.ts tests/perf/latency-and-scale.spec.ts

# one test by name
npx vitest run --config tests/perf/vitest.config.ts -t "survives 100 socket disconnects"

# show the [P6-T1] measurement lines (Vitest intercepts console by default)
npx vitest run --config tests/perf/vitest.config.ts --disable-console-intercept
```

Each run starts a fresh relay + mock LLM on a free port and tears them down afterwards.
A full run takes ~90 s (relay startup dominates).

## What each test does

### network-resilience.spec.ts

- **100 socket disconnects during streaming** — the phone follows a live stream, and every 5
  durable events it cancels its RCP stream, cuts the socket abruptly, reconnects, opens a fresh
  Noise channel, and resumes with `afterSeq`. After 100 cycles every durable event (seq 1..500)
  must be present **exactly once** — zero loss, zero duplication, zero `reset` (cursor-unavailable)
  frames. Production is paced at 33 events/s, under the relay's 50 msg/s per-connection limit, so
  the socket cut is the only loss mechanism under test.
- **Mid-stream disconnect + resume** — an abrupt cut with no graceful cancel; the host keeps
  producing into the void for 800 ms. On reconnect the phone resumes by cursor and must receive
  the full journal exactly once, with post-resume events arriving afterwards.
- **Cold recovery after host restart** — the host's relay connection dies; a new host connection
  is built with the **same identity and persistent registry** (the on-disk state in production).
  the phone re-establishes its session **without re-pairing**, `sessions.list` works, and the
  stream resumes by cursor.

### latency-and-scale.spec.ts

- **Prompt tap → host ACK** — 50 `sessions.prompt` round-trips through the full stack
  (phone → relay → host → gateway). Paced at 250 ms to respect the host's 5 mutating-requests/s
  rate limit. Target: p50 ≤ 400 ms, p95 ≤ 1.2 s.
- **Assistant chunk → stream frame** — 30 assistant chunks spaced 200 ms apart (each flushes
  individually after the 150 ms coalescing window). Measures gateway-yield → phone-received.
  Target: p50 ≤ 350 ms.
- **10,000-event scale** — drives the host pipeline (`SessionAdapter` → `RcpServer`) directly
  via `RcpServer.handleMessage` with an intercepted transport sender, so the relay's 50 msg/s
  limit doesn't dominate. Verifies exactly-once delivery of all 10,000 events and reports
  throughput. (The Noise/SC-1/relay path is covered by the resilience suite and the full-stack
  tests; see the report for why this level was chosen.)
- **Memory growth** — 1,000 iterations of (follow → 10 events → cancel → prompt) with a fast
  injected clock (so the rate limiter never throttles) and `--expose-gc`. RSS is measured before
  and after with a forced GC; growth must stay under 32 MB.
- **Relay daily projection** — streams 20 chunks/s (coalesced to ~7 frames/s) for ~16 s through
  the real relay while counting the host's outbound data frames. Projects an 8 h day at
  Cloudflare's 20:1 incoming-message billing. Target: ≤ 20 % of the 100 k free-tier DO quota.
- **Approval → push dispatch** — 20 approval requests through `PendingRegistry` → `HostNotifier`
  → sealed push frame → relay round-trip. Target: p50 ≤ 3 s. (The relay→FCM→phone hop needs a
  real device + Firebase project and is covered by the on-device runbook, not this suite.)

## Reading the numbers

The suite prints one `[P6-T1]` line per measurement (use `--disable-console-intercept` to see
them). The authoritative write-up with the full evaluation table, methodologies, and raw numbers
is [`docs/reports/P6-T1.md`](../../docs/reports/P6-T1.md).

## Notes for contributors

- The perf suite is **not** part of any workspace `tsconfig.json`, so `pnpm run typecheck` does
  not cover it. Vitest transforms with oxc (no type-check at run time). Keep the spec files
  type-clean by the repo's conventions (`strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`) even though nothing enforces it in CI today.
- `vitest.config.ts` sets top-level `execArgv: ['--expose-gc']` so the memory test can force
  GC. Vitest 4's `defineConfig` type (vite's `UserConfig`) does not declare this key — a known
  Vitest 4 typing gap; the runtime accepts it.
- Tests share one relay per spec file (`beforeAll`/`afterAll`) and run serially
  (`fileParallelism: false`, `maxWorkers: 1`) — they are timing-sensitive and bind ports.
