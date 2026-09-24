import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // The cross-language interop test builds the Kotlin fat jar on first run
    // (Gradle wrapper download + Kotlin compile), which can take minutes.
    testTimeout: 30_000,
    hookTimeout: 600_000,
  },
})
