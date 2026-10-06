import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Tests run inside workerd with the bindings from wrangler.jsonc (Durable Objects
// included), using per-test isolated storage.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // The relay fails closed when no enrollment secret is configured
        // (503, RLY/1 §4.1), so the tests provide one through this binding.
        // It is a fixed, obviously fake test value (AGENTS.md §10); a real
        // deployment sets it with `wrangler secret put REMORA_ENROLL_SECRET`.
        bindings: { REMORA_ENROLL_SECRET: 'test-enroll-secret' },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
})
