/**
 * @remora/testkit — test-only tooling: `FakeDevice` (a TypeScript phone that
 * speaks RLY/1 + SC/1 + RCP/1), an adversarial relay mode, and the e2e
 * environment that starts a local relay, a mock LLM, and dsh with an isolated
 * `DSH_HOME`.
 *
 * Implementation: task P1-T1. Never shipped to users.
 */

export * from './device.ts'
export * from './adversary.ts'
export * from './mock-llm.ts'
export * from './env.ts'
