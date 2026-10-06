# @remora/host

The PC side of Remora: an out-of-tree **DeepSeek Harness bundle** (`package.json#dsh.bundle.patch` → `cordis.patch.yml`) whose row `remora` mounts this package as a Cordis plugin inside the dsh process. It dials out to the relay, terminates the end-to-end channel, serves RCP/1 to paired phones, and reaches dsh only through `ctx.typertGateway` and Cordis events.

- **Architecture:** [blueprint §8](../../docs/blueprint.md#8-remora-host-remorahost) · **dsh facts:** [dsh-integration.md](../../docs/upstream/dsh-integration.md) · **Decisions:** ADR-0001, 0003, 0007, 0008, 0009
- **Implemented by:** P1-H1 (foundation), P2-H1 (pairing), P2-H2 (sessions), P3-H1 (AnswerBridge), P3-H2 (Policy Guard), P4-H1/H2 (workspaces, files, diffs), P5-H1 (notifier), P5-O1 (keep-awake)
- **Owner role:** host (AGENTS.md §3). Only `src/adapter/**` and `src/interaction/dsh-*.ts` may import `@deepseek-ai/*` beyond Cordis and schemastery.

## Status

`apply()` validates configuration (`relayUrl` required, https except loopback, absolute roots), then starts the host: it dials the relay, terminates the end-to-end channel for paired phones, serves RCP/1, adapts dsh sessions through the gateway (P2-H2), and runs pairing (P2-H1). The management page is served on the dsh web origin at `/api/remora/` (exact route plus a 303 from the trailing-slash alias); when the host has no paired device, the first pairing attempt opens automatically as soon as the relay connects and its QR is printed to an attached TTY.

### Handshake and runtime status

`hello` validates the phone's RCP version offer and returns the shared RCP/1
schema, including the real host platform, package versions, configured policy
and canonical allowed roots. `host.status` reads the current Agent registry and
the keep-awake driver's acquired state. Its uptime measures this RCP server's
lifetime. Version/profile discovery uses the pinned dsh CLI manifest and the
root Cordis profile URL inside `src/adapter/runtime.ts`; missing metadata fails
the call instead of announcing a guessed version or profile. Other dsh launchers
need a separately verified metadata seam. Runtime verification is deferred.

### Approval and question bridge

The AnswerBridge uses typed dsh waterfalls and races the PC answerer against
paired phones. Startup awaits an ordering self-check whose probe stops before
ordinary listeners; failure refuses plugin startup before opening relay resources.
When the phone wins, the bridge aborts the derived request signal to withdraw the
PC prompt without cancelling the parent turn.

Real dsh approval requests identify a tool call but do not carry its arguments.
The bridge reads the matching call from the real Session journal, preserving the
Session method receiver, and parses the model's JSON arguments. Display previews
are limited to 2 KiB per field. Risk classification receives the complete parsed
arguments before truncation. Missing, malformed, or mismatched call metadata is
high risk. The configured `approvalBiometric` policy is enforced by the host's
actual approval handler, and `approvalTimeoutMs` bounds the bridge's waits for
approvals and questions.

`test/interaction/journal-policy.test.ts` exercises the pinned dsh Session class;
`test/apply.test.ts` checks production wiring and rejects unsigned or invalidly
signed approvals through the real RCP handler. Recorded-fixture tests also cover
tool event mapping and PC-chain withdrawal. Full phone-to-host scenarios remain
the scope of P7-T1.

Approval keys from Android are P-256 SubjectPublicKeyInfo (SPKI) DER, and signatures are ECDSA DER. `devices.rotateApprovalKey` accepts SPKI and legacy uncompressed SEC1 points, validates the curve and point with Node crypto, and normalizes the pending/stored value to SPKI before PC confirmation. Existing registry entries are not silently migrated: an older raw SEC1 approval key can be replaced through another PC-confirmed rotation. Pending/duplicate/conflict responses and the required PC confirmation remain unchanged.

### Foreground workspace and session control streams

`workspaces.follow` returns its stream-open response after opening the dsh
iterator, while a background consumer sends the baseline and later changes.
Cancellation and channel disposal abort that iterator. Reconnect baselines
replace the cached workspace set, including rows deleted while disconnected.

`sessions.control` retains queue and job components independently when dsh sends
replacement frames. Live running state comes from the actual Agent registry and
typed `agent/status` events; session disposal removes its control row. Activity
listeners belong to the plugin fiber and are removed when the stream ends.
These repairs are implemented in the coding-first P7 completion branch; runtime
and real-dsh verification remain deferred in the associated handoff.

## Try it in a throwaway dsh profile

Never install into your everyday `web` profile. From the repository root:

```sh
pnpm -F @remora/host run build
pnpm -F @remora/host pack                  # writes remora-host-<version>.tgz into the repo root
dsh --profile remora-dev --from-default-profile web
dsh plugin --profile remora-dev add ./remora-host-1.0.0.tgz --allow-build koffi
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
- **Production / Standard Install:** Packed tarball (`pnpm -F @remora/host pack` followed by `dsh plugin --profile remora-dev add ./remora-host-<version>.tgz --allow-build koffi`). This isolates dependencies strictly to the profile's hoisted environment, guaranteeing that `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` remain singletons and avoiding duplicate loader/symbol collisions.
- **Fast Local Iteration:** `dsh plugin --profile remora-dev add ./packages/host --allow-build koffi` is supported during development provided the monorepo root does not install mismatched versions of the peer dependencies.

Since P7-H8 the tarball is the documented install path and is self-contained: the build
(`tsdown`, see `tsdown.config.ts`) bundles the unpublished workspace packages
`@remora/crypto`, `@remora/protocol`, `@remora/relay-link` and `qrcode` into `lib/index.js`,
so the packed manifest's runtime dependencies are the published `ws` and `koffi` packages. The dsh
peer dependencies `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` stay external
(peer dependencies) — dsh provides them, and bundling them would break Loader/schema
identity (dsh-integration.md Q10).

`pnpm -F @remora/host run build` first builds the workspace packages it bundles
(`pnpm --filter "@remora/host^..." run build`), so it works from a clean checkout. The bundle
fails closed: an import tsdown cannot resolve fails the build instead of being left as an
external import, and `lib/index.js` may import only `@deepseek-ai/cordis`,
`@deepseek-ai/schemastery`, `ws`, `koffi` and Node built-ins (`deps.onlyImport`). `pnpm pack` does not
build, so always build before packing. `test/pack.test.ts` checks the whole path in the unit
test run: it copies the workspace without any build output to a temp directory, runs only this
package's `build`, packs, installs the tarball next to the two dsh peers in an empty directory,
and imports it. On Windows it also mounts the installed plugin on real Cordis, emits an
agent status, observes the native system-required flag and checks disposal releases it.

`koffi` stays external so its native binaries resolve relative to its installed package.
The pinned library is necessary because Node does not expose `SetThreadExecutionState`.
pnpm 12 requires an explicit install-script decision: `--allow-build koffi` permits only
this native dependency's installer in the selected throwaway profile. Without that option,
installation fails with `ERR_PNPM_IGNORED_BUILDS`; do not disable the build-script policy
globally. The repository's `pnpm-workspace.yaml` permits the same dependency for development.

## Windows keep-awake

With `keepAwake: while-busy`, the host loads `koffi` asynchronously and invokes
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` synchronously on the Node
thread. The same thread releases with `ES_CONTINUOUS` after the last active agent's
two-minute grace period, or immediately on plugin disposal. Acquisition becomes true only
after the Windows call succeeds; loading that finishes after release cannot create a hold.
The display can sleep. Explicit sleep, lid-close and power policies still apply.

If the native library cannot load or acquire, the host warns once through `ctx.logger` and
starts a hidden, noninteractive PowerShell helper using the same Windows API. The helper
confirms acquisition only after the API succeeds. Its stdin pipe owns its lifetime: normal
release terminates it, and parent-process exit closes the pipe so it releases without an
orphan request. Startup is bounded to ten seconds; failure leaves acquisition false and
emits a fixed warning without subprocess output or machine paths.

`pnpm -F @remora/host test -- platform` exercises the real native API and helper on Windows.
The privileged `test/platform/verify-windows-power-request.mjs` probe additionally checks
`powercfg /requests` under a uniquely named Node executable; a standard user cannot run
that observation, even though keep-awake itself needs no administrator rights.
