/**
 * @remora/host — the PC side of Remora. dsh loads this module as the Cordis
 * plugin of the `remora` row inserted by this package's bundle patch
 * (`cordis.patch.yml`).
 */
import os from 'node:os'
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'
// Declaration merging: this type-only import teaches the compiler that
// `ctx.typertGateway` (api-gateway) exists on the Cordis Context. The dsh
// event names (`session/event`, `agent/error`, `agent/status`) are augmented
// by the type-only imports inside src/notify/dsh-events.ts, where the handlers
// live; they are devDependencies pinned to the upstream.lock.json version and
// never imported at runtime.
import type {} from '@deepseek-ai/dsh-api-gateway'
import { decodeBase64Url } from '@remora/crypto'
import { ChannelManager } from './channel/index.ts'
import { Config, resolveConfig } from './config.ts'
import { RetryingGateway } from './adapter/gateway.ts'
import { createSessionActivitySource } from './adapter/session-control.ts'
import { loadPersistentDeviceRegistry, type DeviceRecord } from './devices/index.ts'
import { loadOrCreateHostIdentity } from './identity/credentials.ts'
import { PairingService } from './pairing/index.ts'
import { RcpServer } from './rcp/index.ts'
import {
  HostRelayConnection,
  describeEnrollmentFailure,
  ensureHostEnrolled,
  forgetRelayEnrollment,
  resolveEnrollSecret,
  type RelayEnrollmentCredentials,
} from './relay/index.ts'
import { printTerminalQr } from './web/index.ts'
import { registerManagementRoutes } from './web/routes.ts'
import { PendingRegistry, registerAnswerBridge, runAnswerBridgeSelfCheck } from './interaction/index.ts'
import { registerInteractionMethods } from './rcp/methods/interaction.ts'
import { ApprovalKeyRotationManager, registerDevicesMethods } from './rcp/methods/devices.ts'
import { DefaultPolicyGuard } from './policy/index.ts'
import { HostNotifier, PresenceTrackingSessionAdapter, registerDshEventBridge } from './notify/index.ts'
import { registerNotifyMethods } from './rcp/methods/notify.ts'
import { WorkspaceAdapter } from './adapter/workspaces.ts'
import { registerWorkspaceMethods } from './rcp/methods/workspaces.ts'
import { FsAdapter, registerFsMethods } from './rcp/methods/fs.ts'
import { registerSessionMethods } from './rcp/methods/sessions.ts'
import { GitAdapter } from './adapter/git.ts'
import { FilesAdapter } from './adapter/files.ts'
import { registerFilesMethods } from './rcp/methods/files.ts'
import { registerDiffsMethods } from './rcp/methods/diffs.ts'

export { Config, RemoraConfigError, resolveConfig } from './config.ts'
export type { NotifyConfig, ResolvedConfig } from './config.ts'
export * from './identity/index.ts'
export * from './identity/credentials.ts'
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
export * from './rcp/methods/devices.ts'
export * from './interaction/index.ts'
export * from './rcp/methods/interaction.ts'
export * from './policy/index.ts'
export * from './notify/index.ts'
export * from './platform/index.ts'

import { KeepAwakeManager } from './platform/index.ts'

/** Stable Cordis plugin name. */
export const name = 'remora'

/**
 * Services required before `apply` runs (Cordis 4 keeps the plugin fiber
 * pending until all of them exist; dsh provides each on its own service
 * fiber — see the P0-S1 spike). The optional web connection is NOT here:
 * the management routes register through `ctx.inject(['connection'], ...)`.
 */
export const inject: string[] = ['typertGateway', 'credentials', 'storage']

/**
 * Plugin body: resolve configuration, load-or-create the persistent host
 * identity from dsh credentials, instantiate device registry, secure channel
 * manager, RCP server, then enroll with the relay (once per relay origin,
 * P7-H3) and connect to it via RelayLink.
 *
 * Async on purpose (P7-H2): Cordis 4 accepts a promise-returning `apply` —
 * the fiber stays pending until the returned promise settles and a rejection
 * fails the plugin loudly (verified against @deepseek-ai/cordis 4.0.2) — so
 * the startup simply awaits the identity record before anything that needs it.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  // dsh's web profile registers no console exporter for the Cordis logger
  // (verified against upstream.lock.json 0.1.5-rc.3: a plugin's ctx.logger
  // output never reaches the terminal), so the owner would never see the
  // host's startup and status lines. Bridge this plugin's records to the
  // terminal with the official formatter, scoped by logger name (the -1
  // default threshold silences every other logger; remora shows up to warn).
  // Registered as an effect of this fiber, so it disappears with the plugin.
  // The write goes through process.stdout like the pairing QR (web/index.ts).
  const consoleBridge: Exporter = {
    colors: false,
    levels: { default: -1, remora: 2 },
    export: (message: Message) => {
      process.stdout.write(`${Logger.format(consoleBridge, message)}\n`)
    },
  }
  ctx.logger.exporter(consoleBridge)
  // Check the Cordis seam before creating credentials, listeners, or relay
  // resources. A failed ordering check must prevent the plugin from starting.
  if (!(await runAnswerBridgeSelfCheck(ctx))) {
    throw new Error('remora: AnswerBridge waterfall self-check failed; host startup refused')
  }
  // The identity persists in the dsh credentials record `remora/host-identity`
  // (crypto-v1.md §3): generated exactly once, reloaded on every restart, so
  // restarting dsh no longer breaks every pairing. `inject` above guarantees
  // the credentials service exists; the structural access is needed because
  // the seam's package is provided by dsh at runtime and not on this bundle's
  // dependency list (spikes/p0-s1-dsh-adapter Q4).
  const credentials = (ctx as Context & { credentials?: RelayEnrollmentCredentials }).credentials
  if (credentials === undefined) {
    throw new Error('remora: the dsh credentials service is required but missing')
  }
  // The relay enrollment secret is required configuration (P7-H3): a missing
  // one fails the load with a RemoraConfigError naming the key and the file to
  // put it in. The value itself is re-resolved for every enrollment attempt.
  await resolveEnrollSecret(credentials, resolved.enrollSecretKey)
  const identity = await loadOrCreateHostIdentity(credentials)
  // The paired devices and their per-device notify preferences persist in the
  // dsh credentials record `remora/devices` (P7-H4; crypto-v1.md §3, §9, §10):
  // loaded on every start so a restart no longer unpairs every phone, written
  // through modifyRecord's atomic single-record writes (a revocation deletes
  // the device's secrets in the same write), and fail closed on a stored
  // record that cannot be parsed. A failed write is surfaced on the log
  // instead of being swallowed; the in-memory state stays authoritative for
  // the running session. The devicePsk/pushKey values cross this boundary
  // inside the record payload only and are never logged (AGENTS.md §1.8).
  const registry = await loadPersistentDeviceRegistry(credentials, {
    onWriteError: (error: unknown) => {
      ctx.logger.error(
        'remora: persisting the device registry failed: %s',
        error instanceof Error ? error.message : 'unknown',
      )
    },
  })
  const hostName = os.hostname()

  // Guards the terminal trigger until `beginPairing` has stored its attempt, so
  // two rapid `ready` events cannot open (and print) two attempts.
  let terminalPairPending = false

  const relay = new HostRelayConnection({
    relayUrl: resolved.relayOrigin,
    identity,
    onStatusChange: (status) => {
      ctx.logger.debug('remora: relay status -> %s', status)
      if (status === 'idle') {
        // RelayLink falls back to idle only when the relay ends the link for
        // good (4401/4403 refusal, 4409 replaced) and does not redial. Forget
        // the remembered enrollment so the next start enrolls again — a relay
        // that lost its endpoint table would otherwise refuse this host forever.
        void forgetRelayEnrollment(credentials).then(
          () => {
            ctx.logger.error(
              'remora: the relay at %s ended the link for good (see the relay error above); its remembered enrollment was cleared, restart dsh to enroll again',
              resolved.relayOrigin,
            )
          },
          (error: unknown) => {
            ctx.logger.error(
              'remora: the relay at %s ended the link for good and its remembered enrollment could not be cleared: %s',
              resolved.relayOrigin,
              error instanceof Error ? error.message : 'unknown',
            )
          },
        )
        return
      }
      if (status !== 'ready') return
      ctx.logger.info('remora: relay ready (host %s)', identity.hostId.slice(0, 6))
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

  // Pending one-shot timers of self-unpair relay revokes, tracked so disposal
  // never leaves one behind (AGENTS.md §7.3: every timer is an effect).
  const pendingUnpairRevokeTimers = new Set<ReturnType<typeof setTimeout>>()

  /**
   * Schedules the relay-side endpoint revoke of a self-unpairing device
   * (crypto-v1.md §10). The relay closes the device's sockets the moment
   * `endpoint.revoke` lands, dropping anything not yet forwarded, so the
   * revoke must be queued to the relay only AFTER the `{ ok: true }` reply of
   * the unpair request has been encoded and handed to the relay link — the
   * channel layer does exactly that right after the RCP handler returns. A
   * 0 ms timer defers past that point; a failure is logged and never
   * undoes the authoritative local revocation.
   */
  const scheduleUnpairRelayRevoke = (deviceId: string): void => {
    const timer = setTimeout(() => {
      pendingUnpairRevokeTimers.delete(timer)
      void revokeEndpointOnRelay(deviceId).catch((error: unknown) => {
        ctx.logger.warn(
          'remora: relay revoke failed for %s: %s',
          deviceId.slice(0, 6),
          error instanceof Error ? error.message : 'unknown',
        )
      })
    }, 0)
    pendingUnpairRevokeTimers.add(timer)
  }

  // The pending approval-key rotations are shared state between the
  // devices.rotateApprovalKey RCP handler and the management page's
  // Confirm/Reject routes (crypto-v1.md §10), so it is created before both.
  const approvalRotations = new ApprovalKeyRotationManager({ registry })

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
    rotations: approvalRotations,
  })

  const rcpServer = new RcpServer({
    hostId: identity.hostId,
    hostName,
    statusProvider: {
      isRelayConnected: () => relay.isConnected,
      getPairedDevicesCount: () => registry.listDevices().filter((d: DeviceRecord) => !d.revoked).length,
    },
  })

  // Observation seam for the method-set parity test (P7-H7): the plugin
  // exposes its RCP server under this service name so a test that mounts the
  // real plugin through apply() can assert the registered method set equals
  // RCP_METHODS (device-callable RCP/1 §4–§10, no host→device entries).
  ctx.provide('remora-rcp-server', rcpServer)

  // The registry itself is the per-device notify-prefs store: the preferences
  // live in the same `remora/devices` record and share its serialized write
  // queue (P7-H4). InMemoryNotifyPrefsStore remains for tests only.
  const notifyPrefsStore = registry
  registerNotifyMethods(rcpServer, notifyPrefsStore)

  // devices.self / devices.unpair / devices.rotateApprovalKey (RCP/1 §7):
  // self-scoped device management. Unpair goes through the registry's
  // revocation path above; its channel closure comes from the on-revoke hook
  // wired to the channel manager below.
  registerDevicesMethods(rcpServer, {
    registry,
    rotations: approvalRotations,
    scheduleRelayRevoke: scheduleUnpairRelayRevoke,
  })

  const policyGuard = new DefaultPolicyGuard({
    remoteRoots: resolved.remoteRoots,
    approvalBiometric: resolved.approvalBiometric,
    approvalAuth: resolved.approvalAuth,
    allowRemoteSessionStart: resolved.allowRemoteSessionStart,
  })

  const pendingRegistry = new PendingRegistry()
  const disposeBridge = registerAnswerBridge(ctx, {
    registry,
    pendingRegistry,
    policyGuard,
    approvalTimeoutMs: resolved.approvalTimeoutMs,
    questionTimeoutMs: resolved.approvalTimeoutMs,
  })

  registerInteractionMethods(rcpServer, pendingRegistry, registry, policyGuard)

  // Guaranteed by `inject` above: without it the fiber never loads, so the
  // previous silent `if (gateway)` branch (which skipped the session methods
  // without a word) is gone — fail closed at load instead.
  //
  // P7-H9's RetryingGateway wraps the raw gateway exactly once so every
  // adapter below survives dsh's startup race (calls reject with
  // `gateway/service-unavailable` until dsh finishes starting); before P7-H2
  // nothing constructed it, leaving the retry logic dead code.
  const gateway = new RetryingGateway(ctx.typertGateway)
  const gitAdapter = new GitAdapter()

  const workspaceAdapter = new WorkspaceAdapter({ gateway, policyGuard })
  registerWorkspaceMethods(rcpServer, workspaceAdapter)

  const fsAdapter = new FsAdapter({ gateway, policyGuard })
  registerFsMethods(rcpServer, fsAdapter)

  // The presence-tracking subclass (P7-H5) is the real SessionAdapter plus one
  // observation: every opened `sessions.follow` stream is recorded as session
  // follow presence, which `isDeviceForegrounded` below consults. The
  // open-channel half of presence comes from the ChannelManager probe.
  const sessionAdapter = new PresenceTrackingSessionAdapter({
    gateway,
    policyGuard,
    workspaceAdapter,
    activity: createSessionActivitySource(ctx),
  })
  registerSessionMethods(rcpServer, sessionAdapter, (sessionId, deviceId) => {
    notifier.recordSessionDevice(sessionId, deviceId)
  })

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
    // Real presence (P7-H5): foregrounded means the device holds an open
    // channel AND an active `sessions.follow` for the session — it receives
    // the events in-band, so the push would only duplicate them. The
    // notifier ANDs both halves; this callback answers the follow half.
    isDeviceForegrounded: (deviceId, sessionId) =>
      sessionId !== undefined && sessionAdapter.follows.isFollowing(sessionId, deviceId),
  })

  const detachNotifier = notifier.attachPendingRegistry(pendingRegistry)

  const keepAwakeManager = new KeepAwakeManager({
    enabled: resolved.keepAwake === 'while-busy',
    gracePeriodMs: 120_000,
    warn: (message) => ctx.logger.warn('%s', message),
  })

  // The dsh event wiring (P7-H5): the handlers are typed against the real dsh
  // signatures — `session/event` is emitted as `(session, event)`, `agent/error`
  // as `{ agent, turn, step, error }` with the session id on `agent.id`, and
  // `agent/status` as `{ agent, status }` (upstream.lock.json 0.1.5-rc.3) — and
  // live in src/notify/dsh-events.ts, which owns the shape knowledge. Routing:
  // turn ends and agent errors go to the notifier (turn-done/turn-error pushes
  // to the devices in the session's audience), agent statuses to keep-awake.
  // A session's title is a projection real dsh does not expose on the emitted
  // Session, so the notifier renders its default titles.
  registerDshEventBridge(ctx, {
    onTurnEnded: (sessionId) => {
      void notifier.notifyTurnDone(sessionId, null).catch(() => {})
    },
    onTurnErrored: (sessionId, errorText) => {
      void notifier.notifyTurnError(sessionId, errorText, null).catch(() => {})
    },
    onAgentStatus: (agentId, status) => {
      keepAwakeManager.handleAgentStatus(agentId, status)
    },
  })

  // Enrollment (relay-v1.md §4.1) must precede the first relay connection: the
  // relay refuses an endpoint it does not know (4403). It runs in the
  // background so the plugin and its management page are up while an
  // unreachable relay is retried with backoff; a final failure (401, a
  // malformed answer) is logged once and the relay loop is never started.
  const connectAbort = new AbortController()
  let connecting: Promise<void> = Promise.resolve()

  // Disposer: stop enrolling, zeroize channel keys, persist any pending
  // registry change (a revoke right before shutdown must not be lost — the
  // flush is one bounded record write), then close the relay socket. Runs
  // when the fiber unloads; dsh waits up to 2 s for it (AGENTS §7.3) — every
  // wait in the enrollment aborts on `connectAbort`.
  ctx.effect(
    () => async () => {
      ctx.logger.info('remora: disposing host plugin')
      connectAbort.abort()
      detachNotifier()
      keepAwakeManager.dispose()
      disposeBridge()
      for (const timer of pendingUnpairRevokeTimers) clearTimeout(timer)
      pendingUnpairRevokeTimers.clear()
      channelManager.closeAll()
      await connecting
      await registry.flush()
      await relay.stop()
    },
    'remora host',
  )

  connecting = (async () => {
    try {
      const outcome = await ensureHostEnrolled({
        credentials,
        enrollSecretKey: resolved.enrollSecretKey,
        relayOrigin: resolved.relayOrigin,
        identity,
        hostName,
        signal: connectAbort.signal,
        onRetry: (error, delayMs) => {
          ctx.logger.warn(
            'remora: relay enrollment with %s not possible yet (%s); retrying in %d s',
            resolved.relayOrigin,
            error.code,
            Math.round(delayMs / 1000),
          )
        },
        onRememberFailed: (error) => {
          ctx.logger.warn(
            'remora: enrolled with the relay but could not remember it (%s); the next start enrolls again',
            error instanceof Error ? error.message : 'unknown',
          )
        },
      })
      if (connectAbort.signal.aborted) return
      if (outcome === 'enrolled') {
        ctx.logger.info('remora: enrolled with the relay %s (host %s)', resolved.relayOrigin, identity.hostId.slice(0, 6))
      }
      relay.start()
    } catch (error: unknown) {
      if (connectAbort.signal.aborted) return
      // '%s': the line embeds paths such as %USERPROFILE% that must not be read as a format.
      ctx.logger.error('%s', describeEnrollmentFailure(error, resolved))
    }
  })()

  ctx.logger.info(
    'remora: host started (id: %s, relay: %s, %d remote roots)',
    identity.hostId,
    resolved.relayOrigin,
    resolved.remoteRoots.length,
  )
}
