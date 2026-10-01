# @remora/host

The PC side of Remora: an out-of-tree **DeepSeek Harness bundle** (`package.json#dsh.bundle.patch` → `cordis.patch.yml`) whose row `remora` mounts this package as a Cordis plugin inside the dsh process. It dials out to the relay, terminates the end-to-end channel, serves RCP/1 to paired phones, and reaches dsh only through `ctx.typertGateway` and Cordis events.

- **Architecture:** [blueprint §8](../../docs/blueprint.md#8-remora-host-remorahost) · **dsh facts:** [dsh-integration.md](../../docs/upstream/dsh-integration.md) · **Decisions:** ADR-0001, 0003, 0007, 0008, 0009
- **Implemented by:** P1-H1 (foundation), P2-H1 (pairing), P2-H2 (sessions), P3-H1 (AnswerBridge), P3-H2 (Policy Guard), P4-H1/H2 (workspaces, files, diffs), P5-H1 (notifier), P5-O1 (keep-awake)
- **Owner role:** host (AGENTS.md §3). Only `src/adapter/**` and `src/interaction/dsh-*.ts` may import `@deepseek-ai/*` beyond Cordis and schemastery.

## Status

`apply()` validates configuration (`relayUrl` required, https except loopback, absolute roots), then starts the host: it dials the relay, terminates the end-to-end channel for paired phones, serves RCP/1, adapts dsh sessions through the gateway (P2-H2), and runs pairing (P2-H1). The management page is served on the dsh web origin at `/api/remora/` (exact route plus a 303 from the trailing-slash alias); when the host has no paired device, the first pairing attempt opens automatically as soon as the relay connects and its QR is printed to an attached TTY.

## Try it in a throwaway dsh profile

Never install into your everyday `web` profile. From the repository root:

```sh
pnpm -F @remora/host run build
pnpm -F @remora/host pack                  # writes remora-host-<version>.tgz into the repo root
dsh --profile remora-dev --from-default-profile web
dsh plugin --profile remora-dev add ./remora-host-1.0.0.tgz
```

Then add to `~/.dsh/profiles/remora-dev/cordis.patch.yml` (a patch replaces the whole row config, so restate every key from this package's `cordis.patch.yml`):

```yaml
- id: remora
  config:
    relayUrl: http://127.0.0.1:8787
    enrollSecretKey: REMORA_RELAY_ENROLL_SECRET
    remoteRoots: []
    approvalBiometric: high
    approvalAuth: biometric
    approvalTimeoutMs: 3600000
    allowRemoteSessionStart: true
    keepAwake: while-busy
    streamCoalesceMs: 150
    notify: { approval: true, question: true, turnDone: true, turnError: true, hostOffline: true }
```

`dsh --profile remora-dev --dump-config` shows the row; `dsh --profile remora-dev --no-open --port 7718` loads it.

### Install Form (P0-S1 Decision, self-contained since P7-H8)

Spike P0-S1 answered Q10 regarding installation packaging:
- **Production / Standard Install:** Packed tarball (`pnpm -F @remora/host pack` followed by `dsh plugin --profile remora-dev add ./remora-host-<version>.tgz`). This isolates dependencies strictly to the profile's hoisted environment, guaranteeing that `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` remain singletons and avoiding duplicate loader/symbol collisions.
- **Fast Local Iteration:** `dsh plugin --profile remora-dev add ./packages/host` is supported during development provided the monorepo root does not install mismatched versions of the peer dependencies.

Since P7-H8 the tarball is the documented install path and is self-contained: the build
(`tsdown`, see `tsdown.config.ts`) bundles the unpublished workspace packages
`@remora/crypto`, `@remora/protocol`, `@remora/relay-link` and `qrcode` into `lib/index.js`,
so the packed manifest's only runtime dependency is the published `ws` package. The dsh
peer dependencies `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` stay external
(peer dependencies) — dsh provides them, and bundling them would break Loader/schema
identity (dsh-integration.md Q10).

`pnpm -F @remora/host run build` first builds the workspace packages it bundles
(`pnpm --filter "@remora/host^..." run build`), so it works from a clean checkout. The bundle
fails closed: an import tsdown cannot resolve fails the build instead of being left as an
external import, and `lib/index.js` may import only `@deepseek-ai/cordis`,
`@deepseek-ai/schemastery`, `ws` and Node built-ins (`deps.onlyImport`). `pnpm pack` does not
build, so always build before packing. `test/pack.test.ts` checks the whole path in the unit
test run: it copies the workspace without any build output to a temp directory, runs only this
package's `build`, packs, installs the tarball next to the two dsh peers in an empty directory,
and imports it.
