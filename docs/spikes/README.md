# Spike findings

P0 spikes write their findings here as `P0-S<n>.md`. Each finding file contains:

1. **Question(s)** answered (ids from [dsh-integration.md §8](../upstream/dsh-integration.md#8-open-questions-owned-by-spikes) or the task packet).
2. **Environment:** OS, Node, dsh version, device model, tool versions.
3. **Method:** exact commands and code locations (`spikes/<id>/…`) so a reviewer can reproduce in ≤ 15 minutes.
4. **Results:** observations with raw evidence (logs, screenshots, numbers).
5. **Decision / recommendation** and the spec/ADR/packet changes it implies (applied by P0-A2).
6. **Residual unknowns.**

Spike code under `spikes/` is throwaway: it is not part of the pnpm workspace or the Gradle build and is never imported by production code.
