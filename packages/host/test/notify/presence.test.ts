/**
 * Unit tests for session-follow presence (task P7-H5): the FollowTracker
 * state machine, and the real `PresenceTrackingSessionAdapter` observed
 * through a real `follow()` dispatch whose pump is fed by a fake of the dsh
 * gateway (the other side of that seam). The RCP lifecycle is mirrored the
 * way `RcpServer` runs it: a per-stream `AbortSignal` that the sink's `end`
 * aborts (`releaseStream`), so cleanup follows the real stream lifecycle.
 */
import { describe, expect, it, vi } from 'vitest'
import { FollowTracker, PresenceTrackingSessionAdapter } from '../../src/notify/presence.ts'
import type { RcpStreamSink } from '../../src/rcp/index.ts'
import type { InvokeRemoteRequest, TypertGateway } from '../../src/adapter/gateway.ts'

const SESSION = 'session-8d4eacb4-0e4e-4e83-bf6a-00321a631694'
const DEVICE_A = 'd_abcdefghijklmnopqrstuvwxyz'
const DEVICE_B = 'd_mzxw6ytboirx24dhmzxw6ytboi'

describe('P7-H5: FollowTracker', () => {
  it('reports a device as following after follow() and not following after its signal aborts', () => {
    const tracker = new FollowTracker()
    const controller = new AbortController()

    tracker.follow(SESSION, DEVICE_A, controller.signal)
    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(true)

    controller.abort()
    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(false)
  })

  it('keeps other devices following when one device aborts', () => {
    const tracker = new FollowTracker()
    const a = new AbortController()
    const b = new AbortController()

    tracker.follow(SESSION, DEVICE_A, a.signal)
    tracker.follow(SESSION, DEVICE_B, b.signal)
    a.abort()

    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(false)
    expect(tracker.isFollowing(SESSION, DEVICE_B)).toBe(true)
  })

  it('keeps a session followed until every stream of the device ends (refcount)', () => {
    const tracker = new FollowTracker()
    const first = new AbortController()
    const second = new AbortController()

    tracker.follow(SESSION, DEVICE_A, first.signal)
    tracker.follow(SESSION, DEVICE_A, second.signal)
    first.abort()
    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(true)

    second.abort()
    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(false)
  })

  it('separates sessions: ending one session follow leaves other sessions followed', () => {
    const tracker = new FollowTracker()
    const other = 'session-6d1f47a8-0000-0000-0000-000000000000'
    const a = new AbortController()
    const b = new AbortController()

    tracker.follow(SESSION, DEVICE_A, a.signal)
    tracker.follow(other, DEVICE_A, b.signal)
    a.abort()

    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(false)
    expect(tracker.isFollowing(other, DEVICE_A)).toBe(true)
  })

  it('ignores a follow whose signal is already aborted', () => {
    const tracker = new FollowTracker()
    const controller = new AbortController()
    controller.abort()

    tracker.follow(SESSION, DEVICE_A, controller.signal)

    expect(tracker.isFollowing(SESSION, DEVICE_A)).toBe(false)
  })
})

describe('P7-H5: PresenceTrackingSessionAdapter', () => {
  /** A fake of the dsh gateway whose `session/follow` stream yields one snapshot and ends. */
  function gatewayWithFollowStream(): TypertGateway {
    return {
      invoke: (_request: InvokeRemoteRequest) => {
        throw new Error('presence test: gateway.invoke must not be called')
      },
      stream: (_request: InvokeRemoteRequest) =>
        (async function* () {
          yield { type: 'snapshot', header: {}, records: [], hasMore: false }
        })(),
    }
  }

  /** An RCP stream sink whose `end` aborts its controller, mirroring RcpServer.releaseStream. */
  function createFakeSink(deviceId: string): { sink: RcpStreamSink; controller: AbortController } {
    const controller = new AbortController()
    return {
      controller,
      sink: {
        sid: 1,
        deviceId,
        channelId: 1,
        signal: controller.signal,
        sendItem: async () => true,
        end: async () => {
          controller.abort()
          return true
        },
      },
    }
  }

  it('records follow presence when sessions.follow opens and clears it when the stream ends', async () => {
    const adapter = new PresenceTrackingSessionAdapter({ gateway: gatewayWithFollowStream() })
    const { sink, controller } = createFakeSink(DEVICE_A)

    await adapter.follow({ sessionId: SESSION }, sink)
    expect(adapter.follows.isFollowing(SESSION, DEVICE_A)).toBe(true)

    // The pump drains the (one-frame) stream and calls sink.end, which aborts
    // the stream signal the way RcpServer.releaseStream does.
    await vi.waitFor(() => {
      expect(controller.signal.aborted).toBe(true)
      expect(adapter.follows.isFollowing(SESSION, DEVICE_A)).toBe(false)
    })
  })

  it('still delivers the real follow payload while presence is recorded', async () => {
    const adapter = new PresenceTrackingSessionAdapter({ gateway: gatewayWithFollowStream() })
    const { sink, controller } = createFakeSink(DEVICE_A)
    const items: Array<Record<string, unknown>> = []
    const observingSink: RcpStreamSink = {
      ...sink,
      sendItem: async (data) => {
        items.push(data)
        return true
      },
    }

    await adapter.follow({ sessionId: SESSION }, observingSink)
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))

    expect(items).toEqual([expect.objectContaining({ type: 'snapshot' })])
  })
})
