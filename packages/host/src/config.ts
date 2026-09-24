/**
 * Configuration of the `remora` row: the schemastery schema dsh validates, and
 * the explicit `resolveConfig()` step that turns it into the values the plugin
 * runs with. Misconfiguration throws at load (fail loud), never later.
 */
import { isAbsolute } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Per-kind push notification switches (blueprint §8.10). */
export interface NotifyConfig {
  approval: boolean
  question: boolean
  turnDone: boolean
  turnError: boolean
  hostOffline: boolean
}

/** The `config` object of the `remora` row in cordis.patch.yml. */
export interface Config {
  /** Relay origin, e.g. `https://remora-relay.example.workers.dev`. Required. */
  relayUrl: string
  /** dsh credentials key name holding the relay enrollment secret (never the value). */
  enrollSecretKey: string
  /** Absolute directories the phone may browse and start sessions in. */
  remoteRoots: string[]
  /** Which approvals need a biometric-bound signature. */
  approvalBiometric: 'high' | 'all' | 'never'
  /** Whether a device credential may replace a biometric (ADR-0007 fallback). */
  approvalAuth: 'biometric' | 'biometric-or-credential'
  /** Longest wait for a phone answer before the bridge resolves `unavailable`. */
  approvalTimeoutMs: number
  /** Whether phones may create workspaces and start sessions. */
  allowRemoteSessionStart: boolean
  /** Keep the PC awake while agents run. */
  keepAwake: 'off' | 'while-busy'
  /** Coalescing window for live assistant output, in milliseconds. */
  streamCoalesceMs: number
  /** Push notification switches. */
  notify: NotifyConfig
}

export const NotifyConfig: z<NotifyConfig> = z.object({
  approval: z.boolean().default(true),
  question: z.boolean().default(true),
  turnDone: z.boolean().default(true),
  turnError: z.boolean().default(true),
  hostOffline: z.boolean().default(true),
})

export const Config: z<Config> = z.object({
  relayUrl: z.string().default(''),
  enrollSecretKey: z.string().default('REMORA_RELAY_ENROLL_SECRET'),
  remoteRoots: z.array(z.string()).default([]),
  approvalBiometric: z.union([z.const('high'), z.const('all'), z.const('never')]).default('high'),
  approvalAuth: z.union([z.const('biometric'), z.const('biometric-or-credential')]).default('biometric'),
  approvalTimeoutMs: z.natural().default(3_600_000),
  allowRemoteSessionStart: z.boolean().default(true),
  keepAwake: z.union([z.const('off'), z.const('while-busy')]).default('while-busy'),
  streamCoalesceMs: z.natural().default(150),
  notify: NotifyConfig,
})

/** Configuration after explicit validation and defaulting. */
export interface ResolvedConfig extends Readonly<Omit<Config, 'remoteRoots' | 'notify'>> {
  readonly relayOrigin: string
  readonly remoteRoots: readonly string[]
  readonly notify: Readonly<NotifyConfig>
}

/** Thrown for configuration the plugin cannot run with; the message says how to fix it. */
export class RemoraConfigError extends Error {
  override readonly name = 'RemoraConfigError'
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Validate a schema-checked config and derive the values the plugin runs with.
 * @param config - the row config after dsh's schema validation.
 * @returns the resolved, frozen configuration.
 * @throws {RemoraConfigError} when the relay URL or a root is unusable.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  if (config.relayUrl.trim() === '') {
    throw new RemoraConfigError(
      'remora: config.relayUrl is required; set it in the profile cordis.patch.yml (see docs/runbooks/operations.md §3)',
    )
  }
  let url: URL
  try {
    url = new URL(config.relayUrl)
  } catch {
    // `new URL` throws TypeError for malformed input; that is the only failure here.
    throw new RemoraConfigError(`remora: config.relayUrl is not a valid URL: ${JSON.stringify(config.relayUrl)}`)
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RemoraConfigError('remora: config.relayUrl must use https (plain http is allowed only for a loopback development relay)')
  }
  for (const root of config.remoteRoots) {
    if (!isAbsolute(root)) {
      throw new RemoraConfigError(`remora: every entry of config.remoteRoots must be an absolute path: ${JSON.stringify(root)}`)
    }
  }
  if (config.enrollSecretKey.trim() === '') {
    throw new RemoraConfigError('remora: config.enrollSecretKey must name a dsh credentials key')
  }
  return Object.freeze({
    ...config,
    relayOrigin: url.origin,
    remoteRoots: Object.freeze([...config.remoteRoots]),
    notify: Object.freeze({ ...config.notify }),
  })
}
