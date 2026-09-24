# ADR-0010: One monorepo — pnpm TypeScript workspace + Gradle Android + shared vectors

- Status: Accepted
- Date: 2026-09-24
- Deciders: Integrator

## Context

Remora spans a dsh plugin (TypeScript, Node), a Cloudflare Worker (TypeScript, workerd), shared protocol/crypto libraries, and an Android app (Kotlin). Protocol changes must land in both languages atomically, and several coding agents work in parallel with clear path ownership.

## Decision

- One Git repository. `packages/*`, `apps/relay`, `apps/cli` form a **pnpm workspace**; `apps/android` is an independent **Gradle** build; `conformance/vectors` is consumed by both.
- TypeScript toolchain matched to dsh where it matters: Node ≥ 24 (dsh engines `^22.19 || >=24`), ESM only, TypeScript `^6.0` (dsh uses 6.0), Vitest `^4.1` (required by `@cloudflare/vitest-pool-workers` 0.22), zod 4 for wire validation, `@noble/*` 2.x for crypto, oxlint for lint, wrangler 4 for the relay.
- Android toolchain per ADR-0005.
- GitHub Actions: `ci.yml` (TypeScript: typecheck, lint, unit, relay tests, conformance) and `android.yml` (assemble + JVM unit tests + conformance).
- Task tracking: task packets in `docs/tasks/*.md` are the source of truth; GitHub issues are generated from them by `scripts/sync-issues.mjs`.

## Consequences

- One pull request can change the spec, the TypeScript implementation, the Kotlin implementation, and the vectors together.
- Two build systems; CI minutes on a private repository are metered (Android jobs run only when `apps/android/**` or `conformance/**` change).

## Alternatives considered

- **Polyrepo:** protocol drift between host and app. Rejected.
- **Nx / Turborepo:** unnecessary orchestration at this size. Rejected for now.
- **TypeScript 7 (native compiler):** newer, but dsh builds with 6.0; revisit when dsh moves.
