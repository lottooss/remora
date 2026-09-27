import { defineConfig } from 'vitest/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  execArgv: ['--expose-gc'],
  resolve: {
    alias: {
      '@remora/protocol': path.resolve(__dirname, '../../packages/protocol/src/index.ts'),
      '@remora/crypto': path.resolve(__dirname, '../../packages/crypto/src/index.ts'),
      '@remora/relay-link': path.resolve(__dirname, '../../packages/relay-link/src/index.ts'),
      '@remora/host': path.resolve(__dirname, '../../packages/host/src/index.ts'),
      '@remora/testkit': path.resolve(__dirname, '../../packages/testkit/src/index.ts'),
    },
  },
  test: {
    include: ['tests/perf/**/*.spec.ts'],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
})
