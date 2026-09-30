/**
 * A valid `remora` row config for the apply() harness: every key restated as
 * the real-dsh profile patch does (tests/real-dsh/harness.ts), with the relay
 * pointed at a closed local port so no real socket is opened, and keep-awake
 * off so no driver runs in tests.
 */
import type { Config } from '../../src/config.ts'

/** Base valid config; override single keys per test. */
export function createValidHostConfig(overrides?: Partial<Config>): Config {
  return {
    relayUrl: 'http://127.0.0.1:9',
    enrollSecretKey: 'REMORA_RELAY_ENROLL_SECRET',
    remoteRoots: [],
    approvalBiometric: 'high',
    approvalAuth: 'biometric',
    approvalTimeoutMs: 3_600_000,
    allowRemoteSessionStart: true,
    keepAwake: 'off',
    streamCoalesceMs: 150,
    notify: {
      approval: true,
      question: true,
      turnDone: true,
      turnError: true,
      hostOffline: true,
    },
    ...overrides,
  }
}
