import { defineConfig } from 'vitest/config'

/**
 * Real-dsh boot gate (P7-G1). Deliberately NOT part of `pnpm test`: this suite
 * installs the pinned dsh, boots it, and runs the relay under `wrangler dev`,
 * so it takes minutes and needs network access. CI runs it via the dedicated
 * `real-dsh` workflow (`.github/workflows/real-dsh.yml`).
 */
export default defineConfig({
  test: {
    include: ['tests/real-dsh/**/*.spec.ts'],
    testTimeout: 480_000,
    hookTimeout: 600_000,
    fileParallelism: false,
  },
})
