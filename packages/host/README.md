# @remora/host

The PC side of Remora: an out-of-tree **DeepSeek Harness bundle** (`package.json#dsh.bundle.patch` → `cordis.patch.yml`) whose row `remora` mounts this package as a Cordis plugin inside the dsh process. It dials out to the relay, terminates the end-to-end channel, serves RCP/1 to paired phones, and reaches dsh only through `ctx.typertGateway` and Cordis events.

- **Architecture:** [blueprint §8](../../docs/blueprint.md#8-remora-host-remorahost) · **dsh facts:** [dsh-integration.md](../../docs/upstream/dsh-integration.md) · **Decisions:** ADR-0001, 0003, 0007, 0008, 0009
- **Implemented by:** P1-H1 (foundation), P2-H1 (pairing), P2-H2 (sessions), P3-H1 (AnswerBridge), P3-H2 (Policy Guard), P4-H1/H2 (workspaces, files, diffs), P5-H1 (notifier), P5-O1 (keep-awake)
- **Owner role:** host (AGENTS.md §3). Only `src/adapter/**` and `src/interaction/dsh-*.ts` may import `@deepseek-ai/*` beyond Cordis and schemastery.

## Status

Skeleton: `apply()` validates configuration (`relayUrl` required, https except loopback, absolute roots) and logs. Nothing connects yet.

## Try it in a throwaway dsh profile

Never install into your everyday `web` profile. From the repository root:

```sh
pnpm -F @remora/host run build
dsh --profile remora-dev --from-default-profile web
dsh plugin --profile remora-dev add ./packages/host
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

`dsh --profile remora-dev --dump-config` shows the row; `dsh --profile remora-dev --no-open --port 7718` loads it. Whether a linked local install or a packed tarball (`pnpm -F @remora/host pack`) is the right install form — because of peer-dependency duplication for `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` — is decided by spike P0-S1.
