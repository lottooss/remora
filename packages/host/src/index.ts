/**
 * @remora/host — the PC side of Remora. dsh loads this module as the Cordis
 * plugin of the `remora` row inserted by this package's bundle patch
 * (`cordis.patch.yml`).
 *
 * Skeleton: validates configuration and announces itself. Task P1-H1 adds
 * identity, relay link, secure channel, and the RCP server; later tasks add the
 * dsh adapter, AnswerBridge, Policy Guard, pairing, notifier, and keep-awake
 * (docs/blueprint.md §8). Only `src/adapter/**` and `src/interaction/dsh-*.ts`
 * may import `@deepseek-ai/*` beyond Cordis and schemastery (AGENTS.md §7.3).
 */
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'

export { Config, RemoraConfigError, resolveConfig } from './config.ts'
export type { NotifyConfig, ResolvedConfig } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'remora'

/** Services required before `apply` runs. P1-H1 extends this list. */
export const inject: string[] = []

/**
 * Plugin body: resolve configuration (throwing on misconfiguration so the
 * Loader reports the row as failed) and register the host's effects.
 * @param ctx - the plugin's Cordis context.
 * @param config - the row config validated against {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  ctx.logger.info(
    'remora: host skeleton loaded (relay %s, %d remote roots); runtime lands with task P1-H1',
    resolved.relayOrigin,
    resolved.remoteRoots.length,
  )
}
