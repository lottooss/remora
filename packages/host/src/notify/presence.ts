/**
 * Session-follow presence for push suppression (blueprint §8.10, task P7-H5).
 *
 * A device is foregrounded on a session when it has an open channel AND holds
 * an active `sessions.follow` stream for that session: it receives the session
 * events in-band, so a push would only duplicate them. The open-channel half
 * is probed separately through the ChannelManager (`isDeviceConnected`); this
 * module owns the follow half and the adapter hook that feeds it.
 */

import { SessionAdapter } from '../adapter/sessions.ts'
import type { RcpStreamSink } from '../rcp/index.ts'

/** Separator for one (sessionId, deviceId) follow key; neither id contains it. */
const KEY_SEPARATOR = '\u0000'

/**
 * Tracks which devices hold live `sessions.follow` streams for which session.
 * State is cleaned up by the stream's `AbortSignal` — `RcpServer` aborts it on
 * device cancel, channel close, and stream end — so an ended follow can never
 * suppress a push again.
 */
export class FollowTracker {
  /** sessionId → device ids with at least one live follow stream. */
  private readonly sessionDevices = new Map<string, Set<string>>()
  /** follow key → live stream count (a device may follow one session on several channels). */
  private readonly streams = new Map<string, number>()

  /** Records one opened follow stream; the stream's `signal` ends it. */
  follow(sessionId: string, deviceId: string, signal: AbortSignal): void {
    if (signal.aborted) return
    const key = `${sessionId}${KEY_SEPARATOR}${deviceId}`
    // Each stream contributes exactly one abort listener and one count unit.
    signal.addEventListener('abort', () => {
      const count = (this.streams.get(key) ?? 1) - 1
      if (count > 0) {
        this.streams.set(key, count)
        return
      }
      this.streams.delete(key)
      const devices = this.sessionDevices.get(sessionId)
      devices?.delete(deviceId)
      if (devices !== undefined && devices.size === 0) this.sessionDevices.delete(sessionId)
    })
    this.streams.set(key, (this.streams.get(key) ?? 0) + 1)
    let devices = this.sessionDevices.get(sessionId)
    if (devices === undefined) {
      devices = new Set()
      this.sessionDevices.set(sessionId, devices)
    }
    devices.add(deviceId)
  }

  /** Whether `deviceId` currently follows `sessionId` on any stream. */
  isFollowing(sessionId: string, deviceId: string): boolean {
    return this.sessionDevices.get(sessionId)?.has(deviceId) === true
  }
}

/**
 * The real `SessionAdapter` plus exactly one observation: every opened
 * `sessions.follow` stream records (sessionId, deviceId) presence until the
 * stream's signal aborts. Delegation stays the real adapter — only the
 * presence hook is added (SWARM.md §1.3: never mock the unit under test).
 */
export class PresenceTrackingSessionAdapter extends SessionAdapter {
  /** Follow presence recorded by this adapter's `sessions.follow` dispatches. */
  readonly follows = new FollowTracker()

  override async follow(
    params: { sessionId: string; afterSeq?: number | undefined; live?: boolean | undefined },
    sink: RcpStreamSink,
  ): Promise<Record<string, unknown>> {
    this.follows.follow(params.sessionId, sink.deviceId, sink.signal)
    return await super.follow(params, sink)
  }
}
