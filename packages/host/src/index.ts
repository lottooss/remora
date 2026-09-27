/**
 * @remora/host — the PC side of Remora. dsh loads this module as the Cordis
 * plugin of the `remora` row inserted by this package's bundle patch
 * (`cordis.patch.yml`).
 */
import os from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { decodeBase64Url } from '@remora/crypto'
import { ChannelManager } from './channel/index.ts'
import { Config, resolveConfig } from './config.ts'
import { PersistentDeviceRegistry, type DeviceRecord } from './devices/index.ts'
import { createHostIdentity } from './identity/index.ts'
import { PairingService } from './pairing/index.ts'
import { RcpServer } from './rcp/index.ts'
import { HostRelayConnection } from './relay/index.ts'
import { printTerminalQr } from './web/index.ts'
import { registerManagementRoutes } from './web/routes.ts'
import { PendingRegistry, registerAnswerBridge, runAnswerBridgeSelfCheck } from './interaction/index.ts'
import { registerInteractionMethods } from './rcp/methods/interaction.ts'
import { DefaultPolicyGuard } from './policy/index.ts'
import { InMemoryNotifyPrefsStore, HostNotifier } from './notify/index.ts'
import { registerNotifyMethods } from './rcp/methods/notify.ts'
import { WorkspaceAdapter } from './adapter/workspaces.ts'
import { registerWorkspaceMethods } from './rcp/methods/workspaces.ts'
import { FsAdapter, registerFsMethods } from './rcp/methods/fs.ts'
import { SessionAdapter } from './adapter/sessions.ts'
import { registerSessionMethods } from './rcp/methods/sessions.ts'
import { GitAdapter } from './adapter/git.ts'
import { FilesAdapter } from './adapter/files.ts'
import { registerFilesMethods } from './rcp/methods/files.ts'
import { registerDiffsMethods } from './rcp/methods/diffs.ts'

export { Config, RemoraConfigError, resolveConfig } from './config.ts'
export type { NotifyConfig, ResolvedConfig } from './config.ts'
export * from './identity/index.ts'
export * from './devices/index.ts'
export * from './rcp/index.ts'
export * from './channel/index.ts'
export * from './relay/index.ts'
export * from './pairing/index.ts'
export * from './web/index.ts'
export * from './web/routes.ts'
export * from './adapter/index.ts'
export * from './adapter/workspaces.ts'
export * from './adapter/git.ts'
export * from './adapter/files.ts'
export * from './rcp/methods/sessions.ts'
export * from './rcp/methods/workspaces.ts'
export * from './rcp/methods/fs.ts'
export * from './rcp/methods/files.ts'
export * from './rcp/methods/diffs.ts'
export * from './interaction/index.ts'
export * from './rcp/methods/interaction.ts'
export * from './policy/index.ts'
export * from './notify/index.ts'
export * from './platform/index.ts'

import { KeepAwakeManager } from './platform/index.ts'

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
  const hostName = os.hostname()

  // Guards the terminal trigger until `beginPairing` has stored its attempt, so
  // two rapid `ready` events cannot open (and print) two attempts.
  let terminalPairPending = false

  const relay = new HostRelayConnection({
    relayUrl: resolved.relayOrigin,
    identity,
    onStatusChange: (status) => {
      ctx.logger.debug('remora: relay status -> %s', status)
      if (status !== 'ready') return
      // Terminal-only pairing: open one attempt as soon as the relay is usable
      // and nothing is paired yet, so an attached terminal can show the QR
      // without the management page.
      if (terminalPairPending || pairingService.hasActiveAttempt()) return
      if (registry.listDevices().some((device) => !device.revoked)) return
      terminalPairPending = true
      void pairingService
        .beginPairing()
        .then((attempt) => printTerminalQr(attempt.qrPayload, { pairedDeviceCount: 0 }))
        .then((printed) => {
          if (printed) ctx.logger.info('remora: pairing QR printed to the terminal')
        })
        .catch((error: unknown) => {
          ctx.logger.warn(
            'remora: terminal pairing start failed: %s',
            error instanceof Error ? error.message : 'unknown',
          )
        })
        .finally(() => {
          terminalPairPending = false
        })
    },
    onError: (error) => {
      ctx.logger.warn('remora: relay error: %s', error instanceof Error ? error.message : 'unknown')
    },
  })

  /** One relay-issued enrollment ticket (RLY/1 `enroll.ticket`), base64url-decoded. */
  const requestEnrollmentTicket = async (): Promise<Uint8Array> => {
    const reply = await relay.link.request<{ ticket?: unknown }>({ t: 'enroll.ticket' })
    if (typeof reply.ticket !== 'string') throw new Error('relay returned no enrollment ticket')
    return decodeBase64Url(reply.ticket)
  }

  /** Revokes the device endpoint on the relay (RLY/1 `endpoint.revoke`). */
  const revokeEndpointOnRelay = async (deviceId: string): Promise<void> => {
    await relay.link.request({ t: 'endpoint.revoke', id: deviceId })
  }

  const pairingService = new PairingService({
    identity,
    hostName,
    relayOrigin: resolved.relayOrigin,
    registry,
    sendFrame: (bytes: Uint8Array) => {
      relay.sendFrameBytes(bytes)
    },
    requestEnrollmentTicket,
    revokeEndpointOnRelay,
  })

  registry.setOnRevoke((deviceId: string) => {
    channelManager.closeDeviceChannels(deviceId)
  })

  // The management page (and its trailing-slash alias) are exact routes on the
  // dsh web origin: Connection's Host/Origin fence and browser cookie protect
  // them, and every action is same-origin checked again inside the handlers.
  registerManagementRoutes(ctx, {
    pairingService,
    registry,
    relayConnection: relay,
    identity,
    hostName,
    revokeEndpointOnRelay,
  })

  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName,
    statusProvider: {
      isRelayConnected: () => relay.isConnected,
      getPairedDevicesCount: () => registry.listDevices().filter((d: DeviceRecord) => !d.revoked).length,
    },
  })

  const notifyPrefsStore = new InMemoryNotifyPrefsStore()
  registerNotifyMethods(rcpServer, notifyPrefsStore)

  const pendingRegistry = new PendingRegistry()
  const disposeBridge = registerAnswerBridge(ctx, {
    registry,
    pendingRegistry,
  })

  void runAnswerBridgeSelfCheck(ctx)

  const policyGuard = new DefaultPolicyGuard({
    remoteRoots: resolved.remoteRoots,
    approvalBiometric: resolved.approvalBiometric,
    approvalAuth: resolved.approvalAuth,
    allowRemoteSessionStart: resolved.allowRemoteSessionStart,
  })

  registerInteractionMethods(rcpServer, pendingRegistry, registry, policyGuard)

  const gateway = (ctx as any).typertGateway
  const gitAdapter = new GitAdapter()

  let sessionAdapter: SessionAdapter | undefined
  if (gateway) {
    const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard })
    registerWorkspaceMethods(rcpServer, workspaceAdapter)

    const fsAdapter = new FsAdapter({ gateway, policyGuard })
    registerFsMethods(rcpServer, fsAdapter)

    sessionAdapter = new SessionAdapter({
      gateway,
      policyGuard,
      workspaceAdapter,
    })
    registerSessionMethods(rcpServer, sessionAdapter, (sessionId, deviceId) => {
      notifier.recordSessionDevice(sessionId, deviceId)
    })
  }

  const filesAdapter = new FilesAdapter({
    gateway,
    policyGuard,
    gitAdapter,
    sessionAdapter,
  })
  registerFilesMethods(rcpServer, filesAdapter)
  registerDiffsMethods(rcpServer, filesAdapter)

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

  const notifier = new HostNotifier({
    registry,
    prefsStore: notifyPrefsStore,
    config: resolved.notify,
    sendPush: async (frame) => {
      await relay.sendPushFrame(frame)
    },
    isDeviceConnected: (deviceId) => channelManager.hasDeviceSession(deviceId),
    isDeviceForegrounded: (_deviceId, _sessionId) => false,
  })

  const detachNotifier = notifier.attachPendingRegistry(pendingRegistry)

  const keepAwakeManager = new KeepAwakeManager({
    enabled: resolved.keepAwake === 'while-busy',
    gracePeriodMs: 120_000,
  })

  const untypedCtx = ctx as unknown as { on(event: string, callback: (event: unknown) => void): () => void }
  untypedCtx.on('agent/status', (event: unknown) => {
    if (typeof event === 'object' && event !== null) {
      const { agent, status } = event as { agent?: { id?: string } | string; status?: string }
      const agentId = typeof agent === 'object' && agent !== null ? agent.id ?? 'default' : typeof agent === 'string' ? agent : 'default'
      if (typeof status === 'string') {
        keepAwakeManager.handleAgentStatus(agentId, status)
      }
    }
  })
  untypedCtx.on('session/event', (event: unknown) => {
    if (typeof event === 'object' && event !== null) {
      const e = event as { type?: string; sessionId?: string; title?: string }
      if (e.type === 'turn/end' && typeof e.sessionId === 'string') {
        void notifier.notifyTurnDone(e.sessionId, e.title).catch(() => {})
      }
    }
  })
  untypedCtx.on('agent/error', (event: unknown) => {
    if (typeof event === 'object' && event !== null) {
      const e = event as { sessionId?: string; error?: unknown; title?: string }
      if (typeof e.sessionId === 'string') {
        const errText = typeof e.error === 'string' ? e.error : 'Agent encountered an error'
        void notifier.notifyTurnError(e.sessionId, errText, e.title).catch(() => {})
      }
    }
  })

  // Disposer: zeroize channel keys, then close the relay socket. Runs when the
  // fiber unloads; dsh waits up to 2 s for it (AGENTS §7.3).
  ctx.effect(
    () => () => {
      ctx.logger.info('remora: disposing host plugin')
      detachNotifier()
      keepAwakeManager.dispose()
      disposeBridge()
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
