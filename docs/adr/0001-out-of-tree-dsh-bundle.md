# ADR-0001: Extend dsh with an out-of-tree bundle, never a fork

- Status: Accepted
- Date: 2026-09-24
- Deciders: Owner, Integrator

## Context

The DeepSeek Harness is an all-plugin Cordis application. A package whose manifest declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` joins a profile's layer stack when installed with `dsh plugin --profile <name> add <spec>`, including from a local path. Upstream is pre-stable and moves quickly (`0.1.5-rc.2 → 0.1.7-rc.1` in two weeks, daily pushes), declares its public APIs pre-stable, and develops on GitLab with GitHub issues disabled.

## Decision

The host side of Remora is `@remora/host`, an out-of-tree dsh bundle plus Cordis plugin, installed into a custom `remora` profile created from the shipped `web` template. Remora never patches, vendors, or forks upstream packages. When a needed seam is missing, Remora uses the least invasive documented workaround and records a proposal for upstream (GitHub Discussions) in [upstream/dsh-integration.md](../upstream/dsh-integration.md).

## Consequences

- Upgrades flow in through `dsh` releases; no rebase burden.
- Remora can only use seams dsh exposes to plugins (services, events, gateway, Fetch routes). Spikes P0-S1 and P0-S2 validate the ones Remora depends on.
- All dsh-specific code is confined to `packages/host/src/adapter/**` (see ADR-0003) and tested against npm `latest` and `next`.
- The Electron `desktop` profile is out of reach (the CLI refuses plugin management for it).

## Alternatives considered

- **Fork `deepseek-harness`:** full control, but permanent rebase work against a fast-moving pre-stable codebase and divergence from the version the owner runs. Rejected.
- **Separate daemon driving `dsh --profile sdk` or `--profile acp`:** stable-ish JSON-RPC, but a second dsh process competes for the same `$DSH_HOME` sessions, shares no live state with the PC GUI, and receives approvals exclusively (the PC GUI could not answer). Rejected.
