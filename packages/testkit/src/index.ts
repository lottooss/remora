/**
 * @remora/testkit — test-only tooling: `FakeDevice` (a TypeScript phone that
 * speaks RLY/1 + SC/1 + RCP/1), an adversarial relay mode, and the e2e
 * environment that starts a local relay, a mock LLM, and dsh with an isolated
 * `DSH_HOME`.
 *
 * Implementation: task P1-T1. Never shipped to users.
 */

/** Profile name the e2e environment creates inside its temporary `DSH_HOME`. */
export const E2E_PROFILE = 'remora-e2e'
