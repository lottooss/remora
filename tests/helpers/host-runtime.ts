import type { HostRuntimeProvider } from '@remora/host'
import type { Feature } from '@remora/protocol'

/** Explicit metadata for standalone fake hosts; never used by production apply(). */
export function createFixtureHostRuntime(features: readonly Feature[] = ['sessions']): HostRuntimeProvider {
  return {
    hello: () => ({
      os: 'linux',
      pathSeparator: '/',
      versions: { remora: 'test-fixture', dsh: 'fake-dsh' },
      features,
      roots: [],
      policy: { approvalBiometric: 'high', allowRemoteSessionStart: false },
    }),
    status: () => ({
      agentsRunning: 0,
      keepAwake: false,
      dsh: { version: 'fake-dsh', profile: 'remora-e2e' },
    }),
  }
}
