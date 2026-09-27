/**
 * Host Notifier (blueprint §8.10, task P5-H1).
 *
 * Turns AnswerBridge activity and session turn events into per-device,
 * end-to-end encrypted push notifications. Suppression is layered: the host
 * config switch, the per-device preference, then presence — a connected,
 * foregrounded device receives the in-band event instead of a push. Every
 * push is sealed with the target device's own push key, so the relay and
 * FCM only ever carry ciphertext (AGENTS §1.1).
 */

import { buildPushPayload, sealPush } from './payload.ts'
import type { PushKind } from './payload.ts'
import type { NotifyPrefsStore } from './prefs.ts'
import type { NotifyConfig } from '../config.ts'
import type { DeviceRecord, DeviceRegistry } from '../devices/index.ts'
import type { PendingApproval, PendingQuestion, PendingRegistry } from '../interaction/pending.ts'

/** One RLY/1 §5 `push` control frame. */
export interface PushFrame {
  to: string[]
  ct: string
  collapse?: string | undefined
  priority?: 'high' | 'normal' | undefined
  ttl?: number | undefined
}

export interface HostNotifierOptions {
  registry: DeviceRegistry
  prefsStore: NotifyPrefsStore
  config: NotifyConfig
  sendPush: (frame: PushFrame) => Promise<unknown>
  /** Presence probes; without them every device is treated as not foregrounded. */
  isDeviceConnected?: ((deviceId: string) => boolean) | undefined
  isDeviceForegrounded?: ((deviceId: string, sessionId?: string) => boolean) | undefined
}

type PrefKey = 'approval' | 'question' | 'turnDone' | 'turnError'

const PREF_KEY_BY_KIND: Record<PushKind, PrefKey> = {
  approval: 'approval',
  question: 'question',
  turn_done: 'turnDone',
  turn_error: 'turnError',
}

/** A device is a session's audience for 24 h after it opened the session (blueprint §8.10). */
const SESSION_DEVICE_TTL_MS = 24 * 60 * 60 * 1000

/** At most one turn notification per session per 30 s (task P5-H1). */
const TURN_THROTTLE_MS = 30_000

const MAX_TRACKED_SESSIONS = 512

export class HostNotifier {
  private readonly registry: DeviceRegistry
  private readonly prefsStore: NotifyPrefsStore
  private readonly config: NotifyConfig
  private readonly sendPush: (frame: PushFrame) => Promise<unknown>
  private readonly isDeviceConnected: (deviceId: string) => boolean
  private readonly isDeviceForegrounded: (deviceId: string, sessionId?: string) => boolean

  private readonly sessionDevices = new Map<string, Map<string, number>>()
  private readonly lastTurnNotifiedAt = new Map<string, number>()

  constructor(options: HostNotifierOptions) {
    this.registry = options.registry
    this.prefsStore = options.prefsStore
    this.config = options.config
    this.sendPush = options.sendPush
    this.isDeviceConnected = options.isDeviceConnected ?? (() => false)
    this.isDeviceForegrounded = options.isDeviceForegrounded ?? (() => false)
  }

  /** Records that `deviceId` opened `sessionId`, making it a turn-notification audience for 24 h. */
  recordSessionDevice(sessionId: string, deviceId: string): void {
    let devices = this.sessionDevices.get(sessionId)
    if (!devices) {
      devices = new Map()
      this.sessionDevices.set(sessionId, devices)
    }
    devices.set(deviceId, Date.now())
    if (this.sessionDevices.size > MAX_TRACKED_SESSIONS) this.pruneSessionDevices()
  }

  async notifyApproval(item: PendingApproval): Promise<void> {
    if (!this.config.approval) return
    const targets = this.eligibleDevices('approval', this.registry.listDevices(), item.sessionId)
    if (targets.length === 0) return
    const payload = buildPushPayload('approval', {
      sessionId: item.sessionId,
      pendingId: item.id,
      title: item.sessionTitle === null ? 'Approval needed' : `Approval needed · ${item.sessionTitle}`,
      body: `${item.toolName}: ${item.preview.text}`,
    })
    await this.dispatch(targets, payload, { priority: 'high', collapse: `pending:${item.id}` })
  }

  async notifyQuestion(item: PendingQuestion): Promise<void> {
    if (!this.config.question) return
    const targets = this.eligibleDevices('question', this.registry.listDevices(), item.sessionId)
    if (targets.length === 0) return
    const first = item.questions[0]
    const payload = buildPushPayload('question', {
      sessionId: item.sessionId,
      pendingId: item.id,
      title: item.sessionTitle === null ? 'Question' : `Question · ${item.sessionTitle}`,
      body: first?.question ?? 'The agent needs your input',
    })
    await this.dispatch(targets, payload, { priority: 'high', collapse: `pending:${item.id}` })
  }

  async notifyTurnDone(sessionId: string, sessionTitle?: string | null): Promise<void> {
    if (!this.config.turnDone) return
    if (this.isTurnThrottled(sessionId)) return
    const targets = this.eligibleDevices('turn_done', this.devicesForSession(sessionId), sessionId)
    if (targets.length === 0) return
    this.lastTurnNotifiedAt.set(sessionId, Date.now())
    const payload = buildPushPayload('turn_done', {
      sessionId,
      title: sessionTitle == null ? 'Turn done' : `Turn done · ${sessionTitle}`,
      body: sessionTitle ?? 'The agent finished its turn',
    })
    await this.dispatch(targets, payload, { priority: 'normal', collapse: `session:${sessionId}`, ttl: 86400 })
  }

  async notifyTurnError(sessionId: string, errorText: string, sessionTitle?: string | null): Promise<void> {
    if (!this.config.turnError) return
    if (this.isTurnThrottled(sessionId)) return
    const targets = this.eligibleDevices('turn_error', this.devicesForSession(sessionId), sessionId)
    if (targets.length === 0) return
    this.lastTurnNotifiedAt.set(sessionId, Date.now())
    const payload = buildPushPayload('turn_error', {
      sessionId,
      title: sessionTitle == null ? 'Turn failed' : `Turn failed · ${sessionTitle}`,
      body: errorText,
    })
    await this.dispatch(targets, payload, { priority: 'high', collapse: `session:${sessionId}`, ttl: 86400 })
  }

  /**
   * Subscribes to `interaction.follow` deltas: every newly requested pending
   * approval or question pushes to eligible devices. Returns the unsubscribe.
   */
  attachPendingRegistry(pendingRegistry: PendingRegistry): () => void {
    return pendingRegistry.subscribe((event) => {
      if (event.type !== 'requested') return
      const item = event.pending
      if (item.kind === 'approval') {
        void this.notifyApproval(item).catch(() => {})
      } else if (item.kind === 'question') {
        void this.notifyQuestion(item).catch(() => {})
      }
    })
  }

  private eligibleDevices(kind: PushKind, candidates: DeviceRecord[], sessionId?: string): DeviceRecord[] {
    const prefKey = PREF_KEY_BY_KIND[kind]
    return candidates.filter((device) => {
      if (device.revoked) return false
      if (device.pushKey.length !== 32) return false
      if (!this.config[prefKey]) return false
      if (!this.prefsStore.getPrefs(device.deviceId)[prefKey]) return false
      if (this.isForegrounded(device.deviceId, sessionId)) return false
      return true
    })
  }

  private isForegrounded(deviceId: string, sessionId?: string): boolean {
    return this.isDeviceConnected(deviceId) && this.isDeviceForegrounded(deviceId, sessionId)
  }

  private devicesForSession(sessionId: string): DeviceRecord[] {
    const recorded = this.sessionDevices.get(sessionId)
    if (!recorded) return []
    const now = Date.now()
    const devices: DeviceRecord[] = []
    for (const [deviceId, at] of recorded) {
      if (now - at >= SESSION_DEVICE_TTL_MS) continue
      const device = this.registry.getDeviceById(deviceId)
      if (device !== null && !device.revoked) devices.push(device)
    }
    return devices
  }

  private isTurnThrottled(sessionId: string): boolean {
    const last = this.lastTurnNotifiedAt.get(sessionId)
    return last !== undefined && Date.now() - last < TURN_THROTTLE_MS
  }

  /**
   * Seals once per target — every device has its own push key — and sends.
   * One device's push failure must not block the others.
   */
  private async dispatch(
    targets: DeviceRecord[],
    payload: Record<string, unknown>,
    options: { priority: 'high' | 'normal'; collapse: string; ttl?: number },
  ): Promise<void> {
    await Promise.all(
      targets.map(async (device) => {
        try {
          await this.sendPush({
            to: [device.deviceId],
            ct: sealPush(device.pushKey, payload),
            priority: options.priority,
            collapse: options.collapse,
            ttl: options.ttl ?? 86400,
          })
        } catch {
          // per-device send failure is non-fatal
        }
      }),
    )
  }

  private pruneSessionDevices(): void {
    const cutoff = Date.now() - SESSION_DEVICE_TTL_MS
    for (const [sessionId, devices] of this.sessionDevices) {
      for (const [deviceId, at] of devices) {
        if (at < cutoff) devices.delete(deviceId)
      }
      if (devices.size === 0) this.sessionDevices.delete(sessionId)
    }
    while (this.sessionDevices.size > MAX_TRACKED_SESSIONS) {
      const oldest = this.sessionDevices.keys().next()
      if (oldest.done) break
      this.sessionDevices.delete(oldest.value)
    }
    const throttleCutoff = Date.now() - TURN_THROTTLE_MS
    for (const [sId, at] of this.lastTurnNotifiedAt) {
      if (at < throttleCutoff) this.lastTurnNotifiedAt.delete(sId)
    }
  }
}
