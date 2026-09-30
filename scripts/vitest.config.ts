import { defineConfig } from 'vitest/config'

// Test suite for the repo-root gate scripts. scripts/ belongs to no workspace, so the
// per-workspace `pnpm -r run test` cannot pick these up; the root `test` script runs
// this config right after the workspaces so CI's typescript job executes it too.
export default defineConfig({
  root: import.meta.dirname,
  include: ['**/*.test.mjs'],
})
