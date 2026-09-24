/**
 * @remora/host — the PC side of Remora. dsh loads this module as the Cordis
 * plugin of the `remora` row inserted by this package's bundle patch
 * (`cordis.patch.yml`).
 */
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { ChannelManager } from './channel/index.ts'
import { Config, resolveConfig } from './config.ts'
import { PersistentDeviceRegistry, type DeviceRecord } from './devices/index.ts'
import { createHostIdentity } from './identity/index.ts'
import { PairingService } from './pairing/index.ts'
import { RcpServer } from './rcp/index.ts'
import { HostRelayConnection } from './relay/index.ts'

export { Config, RemoraConfigError, resolveConfig } from './config.ts'
export type { NotifyConfig, ResolvedConfig } from './config.ts'
export * from './identity/index.ts'
export * from './devices/index.ts'
export * from './rcp/index.ts'
export * from './channel/index.ts'
export * from './relay/index.ts'
export * from './pairing/index.ts'
export * from './web/index.ts'
export * from './adapter/index.ts'
export * from './rcp/methods/sessions.ts'

/** Stable Cordis plugin name. */
export const name = 'remora'

/** Services required before `apply` runs. */
export const inject: string[] = []

/**
 * Plugin body: resolve configuration, instantiate identity, device registry,
 * secure channel manager, RCP server, and connect to the relay via RelayLink.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const identity = createHostIdentity()
  const registry = new PersistentDeviceRegistry()

  const relay = new HostRelayConnection({
    relayUrl: resolved.relayOrigin,
    identity,
    onStatusChange: (status) => {
      ctx.logger.debug('remora: relay status -> %s', status)
    },
    onError: (error) => {
      ctx.logger.warn('remora: relay error: %s', error instanceof Error ? error.message : 'unknown')
    },
  })

  const pairingService = new PairingService({
    identity,
    hostName: os.hostname(),
    relayOrigin: resolved.relayOrigin,
    registry,
    sendFrame: (bytes: Uint8Array) => {
      relay.sendFrameBytes(bytes)
    },
  })

  registry.setOnRevoke((deviceId: string) => {
    channelManager.closeDeviceChannels(deviceId)
  })

  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName: os.hostname(),
    statusProvider: {
      isRelayConnected: () => relay.isConnected,
      getPairedDevicesCount: () => registry.listDevices().filter((d: DeviceRecord) => !d.revoked).length,
    },
  })

  const channelManager = new ChannelManager({
    identity,
    registry,
    rcpServer,
    sendFrame: (bytes) => {
      relay.sendFrameBytes(bytes)
    },
    pairingService,
  })

  relay.attachChannelManager(channelManager)

  // Disposer: zeroize channel keys, then close the relay socket. Runs when the
  // fiber unloads; dsh waits up to 2 s for it (AGENTS §7.3).
  ctx.effect(
    () => () => {
      ctx.logger.info('remora: disposing host plugin')
      channelManager.closeAll()
      return relay.stop()
    },
    'remora host',
  )

  relay.start()

  ctx.logger.info(
    'remora: host started (id: %s, relay: %s, %d remote roots)',
    identity.hostId,
    resolved.relayOrigin,
    resolved.remoteRoots.length,
  )
}
