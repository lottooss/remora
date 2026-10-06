import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  decodeBase64Url,
  deriveEndpointId,
  encodeBase64Url,
  getRelayPublicKey,
  randomBytes,
  signRelayChallenge,
} from '@remora/crypto'
import { CloseCodes, RLY_SUBPROTOCOL } from '@remora/protocol'
import type { AccountHub } from '../src/account-hub.ts'
import { resetFcmTokenCache } from '../src/fcm.ts'

/**
 * Authentication-timeout alarm (RLY/1 §3, task P7-R2).
 *
 * `AccountHub` uses ONE Durable Object alarm for two purposes: the authentication
 * timeout of unauthenticated sockets (armed on connect) and host-offline alerts
 * (RLY/1 §8). These tests pin the re-arming contract: any path that consumes the
 * shared alarm for one purpose must re-arm it for the other whenever work is still
 * pending — otherwise an unauthenticated socket can stay open (and hibernating)
 * indefinitely. The Durable Object runs for real in workerd; only FCM delivery is
 * faked (the other side of the boundary).
 */

function nextMessage<T = unknown>(ws: WebSocket): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMsg = (event: MessageEvent) => {
      ws.removeEventListener('message', onMsg)
      ws.removeEventListener('close', onClose)
      const handleData = (data: any) => {
        if (typeof data === 'string') {
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            resolve(data as T)
          }
        } else {
          resolve(data as T)
        }
      }

      if (event.data && typeof event.data === 'object' && typeof event.data.arrayBuffer === 'function') {
        event.data.arrayBuffer().then(handleData, reject)
      } else {
        handleData(event.data)
      }
    }
    const onClose = (event: CloseEvent) => {
      ws.removeEventListener('message', onMsg)
      ws.removeEventListener('close', onClose)
      reject(new Error(`WebSocket closed (${event.code}: ${event.reason})`))
    }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('close', onClose)
  })
}

/**
 * Resolves with the socket's close event, or null if it does not close within the
 * timeout — the tests assert on the result, so "never closed" fails an assertion
 * instead of hanging the suite.
 */
function nextClose(ws: WebSocket, timeoutMs = 2000): Promise<CloseEvent | null> {
  return new Promise((resolve) => {
    if (ws.readyState === 3) {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      ws.removeEventListener('close', onClose)
      resolve(null)
    }, timeoutMs)
    const onClose = (event: CloseEvent) => {
      clearTimeout(timer)
      ws.removeEventListener('close', onClose)
      resolve(event)
    }
    ws.addEventListener('close', onClose)
  })
}

interface CapturedFcmRequest {
  url: string
  method?: string | undefined
  headers: Record<string, string>
  body: any
}

function getAccountHubStub(): DurableObjectStub<AccountHub> {
  const ns = (env as unknown as { ACCOUNT_HUB: DurableObjectNamespace<AccountHub> }).ACCOUNT_HUB
  return ns.get(ns.idFromName('account'))
}

/** RLY/1 §3 authentication timeout; the relay default (no AUTH_TIMEOUT_MS var here). */
const AUTH_TIMEOUT_MS = 10_000

/**
 * Host-offline alert delay for this file: the RLY/1 §8 value (120 s). It is far longer
 * than the file takes to run, so a host-offline alarm never fires on its own here; every
 * firing is explicit through {@link runAlarmAt} (P7-R1 lesson).
 */
const HOST_OFFLINE_ALERT_MS = 120_000

/** Key of the relay's host-offline task row (account-hub.ts `OFFLINE_TASK_PREFIX`). */
const OFFLINE_TASK_PREFIX = 'offline:host:'

/**
 * Runs the hub's scheduled alarm, if any, with the clock (`Date.now()`, shared with the
 * Durable Object in this isolate) set to `at`. Returns whether an alarm was scheduled.
 */
async function runAlarmAt(hub: DurableObjectStub<AccountHub>, at: number): Promise<boolean> {
  vi.setSystemTime(at)
  try {
    return await runDurableObjectAlarm(hub)
  } finally {
    vi.useRealTimers()
  }
}

describe('Relay authentication-timeout alarm (RLY/1 §3, P7-R2)', () => {
  const originalFetch = globalThis.fetch
  const capturedFcmRequests: CapturedFcmRequest[] = []
  let fcmMockStatus = 200
  let fcmMockBody: any = { name: 'projects/remora-test-proj/messages/msg_001' }

  const hostPriv = randomBytes(32)
  const hostPub = getRelayPublicKey(hostPriv)
  const hostId = deriveEndpointId('h_', hostPub)
  // Crypto/1 §4: sign over the connection origin, endpoint identity and nonce.
  const RELAY_ORIGIN = 'https://relay.test'
  const signChallengeFor = (priv: Uint8Array, kind: 'host' | 'device', endpointId: string, nonceB64u: string): Uint8Array =>
    signRelayChallenge(priv, { relayOrigin: RELAY_ORIGIN, kind, endpointId, nonce: decodeBase64Url(nonceB64u) })

  const devicePriv = randomBytes(32)
  const devicePub = getRelayPublicKey(devicePriv)
  const deviceId = deriveEndpointId('d_', devicePub)

  /** Opens a WebSocket and reads the challenge, but never authenticates. */
  async function connectUnauth(): Promise<WebSocket> {
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    await nextMessage(ws) // challenge — deliberately left unanswered
    return ws
  }

  /** Opens a WebSocket and completes the RLY/1 §3 challenge/response handshake. */
  async function connectAndAuth(id: string, kind: 'host' | 'device', priv: Uint8Array): Promise<WebSocket> {
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const challenge = await nextMessage<{ nonce: string }>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id,
        kind,
        sig: encodeBase64Url(signChallengeFor(priv, kind, id, challenge.nonce)),
      }),
    )
    const ready = await nextMessage<{ t?: string }>(ws)
    if (ready.t !== 'ready') throw new Error(`expected ready, got: ${JSON.stringify(ready)}`)
    return ws
  }

  /**
   * Closes a host socket and waits until the relay has recorded the disconnect (offline
   * task stored, alarm armed), so the close is never processed inside a later step.
   */
  async function disconnectHost(ws: WebSocket, reason: string): Promise<void> {
    ws.close(CloseCodes.NORMAL, reason)
    const hub = getAccountHubStub()
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const armed = await runInDurableObject(hub, async (_instance: AccountHub, state: DurableObjectState) => {
        const tasks = state.storage.sql
          .exec<{ k: string }>('SELECT k FROM tasks WHERE k = ?1', `${OFFLINE_TASK_PREFIX}${hostId}`)
          .toArray()
        return tasks.length === 1 && (await state.storage.getAlarm()) !== null
      })
      if (armed) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error('relay did not record the host disconnect within 2 s')
  }

  /**
   * Reads `connectedAt` of the newest unauthenticated socket from its hibernation
   * attachment — the exact value the relay's auth-timeout deadline is computed from.
   * "Newest" because a failed earlier test (the bug under test keeps sockets open)
   * can leave older unauthenticated sockets behind.
   */
  async function readNewestPendingConnectedAt(hub: DurableObjectStub<AccountHub>): Promise<number> {
    return await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) => {
      let newest: number | null = null
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { authed?: unknown; connectedAt?: unknown } | null
        if (att && att.authed === false && typeof att.connectedAt === 'number') {
          if (newest === null || att.connectedAt > newest) newest = att.connectedAt
        }
      }
      if (newest === null) throw new Error('no unauthenticated socket found')
      return newest
    })
  }

  /** Reads the due time of the single pending host-offline task row. */
  async function readOfflineTaskDue(hub: DurableObjectStub<AccountHub>): Promise<number> {
    return await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) => {
      const rows = state.storage.sql
        .exec<{ v: string }>('SELECT v FROM tasks WHERE k LIKE ?1', `${OFFLINE_TASK_PREFIX}%`)
        .toArray()
      const row = rows[0]
      if (rows.length !== 1 || row === undefined) throw new Error(`expected 1 offline task, found ${rows.length}`)
      const task = JSON.parse(row.v) as { due?: unknown }
      if (typeof task.due !== 'number') throw new Error('offline task row has no numeric due time')
      return task.due
    })
  }

  beforeAll(async () => {
    ;(env as any).FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'remora-test-proj',
      client_email: 'remora-test@remora-test-proj.iam.gserviceaccount.com',
      private_key: 'dummy-test-key',
    })
    ;(env as any).FCM_ENDPOINT = 'https://fake-fcm.googleapis.com'
    ;(env as any).HOST_OFFLINE_ALERT_MS = String(HOST_OFFLINE_ALERT_MS)

    // Mock global fetch for the fake FCM endpoint
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes('fake-fcm.googleapis.com') || url.includes('/messages:send')) {
        const bodyText = typeof init?.body === 'string' ? init.body : ''
        let parsedBody: any = null
        try {
          parsedBody = JSON.parse(bodyText)
        } catch {
          parsedBody = bodyText
        }
        capturedFcmRequests.push({
          url,
          method: init?.method,
          headers: (init?.headers as Record<string, string>) ?? {},
          body: parsedBody,
        })
        return new Response(JSON.stringify(fcmMockBody), {
          status: fcmMockStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }

    // Enroll host
    const hostRes = await SELF.fetch('https://relay.test/v1/enroll/host', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-enroll-secret' },
      body: JSON.stringify({
        v: 1,
        relayPub: encodeBase64Url(hostPub),
        name: 'AuthTimeoutTestHost',
        platform: 'win32',
      }),
    })
    expect(hostRes.status).toBe(200)

    // Connect host to get enrollment ticket
    const hostWs = await connectAndAuth(hostId, 'host', hostPriv)
    hostWs.send(JSON.stringify({ t: 'enroll.ticket', rid: 'tk1' }))
    const ticketMsg = await nextMessage<{ ticket?: string }>(hostWs)
    const enrolledTicket = ticketMsg.ticket
    if (enrolledTicket === undefined) throw new Error('no ticket in enroll.ticket.ok reply')
    await disconnectHost(hostWs, 'setup complete')

    // Enroll device with ticket
    const devRes = await SELF.fetch('https://relay.test/v1/enroll/device', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        ticket: enrolledTicket,
        relayPub: encodeBase64Url(devicePub),
        name: 'AuthTimeoutTestDevice',
        platform: 'android',
      }),
    })
    expect(devRes.status).toBe(200)

    // Register the device's FCM token with hostOffline: true, so a fired host-offline
    // task produces exactly one captured FCM request
    const devWs = await connectAndAuth(deviceId, 'device', devicePriv)
    devWs.send(
      JSON.stringify({
        t: 'push.token',
        rid: 'pt1',
        token: 'fcm_token_device_abc_123',
        hostOffline: true,
      }),
    )
    const tokenReply = await nextMessage<{ t?: string }>(devWs)
    if (tokenReply.t !== 'ok') throw new Error(`expected ok for push.token, got: ${JSON.stringify(tokenReply)}`)
    devWs.close(CloseCodes.NORMAL, 'setup done')
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(async () => {
    // Test isolation (P7-R1): fire every host-offline alarm an earlier test's host
    // disconnect left pending, before the captures are reset, so it can never fire
    // inside this test.
    await runAlarmAt(getAccountHubStub(), Date.now() + HOST_OFFLINE_ALERT_MS)
    capturedFcmRequests.length = 0
    fcmMockStatus = 200
    fcmMockBody = { name: 'projects/remora-test-proj/messages/msg_001' }
    resetFcmTokenCache()
  })

  it('closes an unauthenticated socket with 4408 when an offline-task cancellation consumed the shared alarm', async () => {
    const hub = getAccountHubStub()

    // Socket connects and never authenticates: the connect must arm the auth-timeout alarm
    const pendingWs = await connectUnauth()
    const connectedAt = await readNewestPendingConnectedAt(hub)
    const pendingDeadline = connectedAt + AUTH_TIMEOUT_MS
    const armed = await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) =>
      state.storage.getAlarm(),
    )
    expect(armed, 'connecting must arm the auth-timeout alarm').toBe(pendingDeadline)

    // Offline-task cancellation: host connects and authenticates, disconnects (offline task
    // armed), then reconnects and authenticates — onAuth cancels the offline task
    const hostWs1 = await connectAndAuth(hostId, 'host', hostPriv)
    await disconnectHost(hostWs1, 'trigger offline task')
    const hostWs2 = await connectAndAuth(hostId, 'host', hostPriv)

    // Running the alarm at connectedAt + 10 s must still close the unauthenticated socket
    // with 4408: the cancellation must have re-armed the shared alarm for its deadline.
    const closePromise = nextClose(pendingWs)
    const alarmRan = await runAlarmAt(hub, pendingDeadline)
    const closeEvent = await closePromise
    expect(alarmRan, 'an alarm must still be scheduled for the unauthenticated socket').toBe(true)
    expect(closeEvent, 'the unauthenticated socket must be closed').not.toBeNull()
    expect(closeEvent?.code).toBe(CloseCodes.AUTH_TIMEOUT)

    hostWs2.close(CloseCodes.NORMAL, 'done')
  })

  it('re-arms the alarm for an unauthenticated socket when an earlier host-offline alarm fires', async () => {
    const hub = getAccountHubStub()

    // Connect the pending socket ~10 min in the future: its auth deadline
    // (connectedAt + 10 s) then lies far beyond the offline task's due time
    // (real now + 120 s), so the first alarm to fire is the task's — while the
    // socket is not yet due.
    const future = Date.now() + 600_000
    vi.setSystemTime(future)
    let pendingWs: WebSocket
    try {
      pendingWs = await connectUnauth()
    } finally {
      vi.useRealTimers()
    }
    const connectedAt = await readNewestPendingConnectedAt(hub)
    const pendingDeadline = connectedAt + AUTH_TIMEOUT_MS

    // Host connects, authenticates, disconnects: arms the host-offline task, due long
    // before the pending socket's auth deadline
    const hostWs = await connectAndAuth(hostId, 'host', hostPriv)
    await disconnectHost(hostWs, 'go offline')
    const taskDue = await readOfflineTaskDue(hub)
    expect(taskDue, 'the offline task must be due before the socket deadline').toBeLessThan(pendingDeadline)

    // The alarm fires for the offline task: the metadata-only alert is dispatched
    expect(await runAlarmAt(hub, taskDue)).toBe(true)
    expect(capturedFcmRequests.length).toBe(1)
    const alertPush = capturedFcmRequests[0]
    expect(alertPush?.body?.message?.token).toBe('fcm_token_device_abc_123')
    expect(alertPush?.body?.message?.data).toEqual({ v: '1', h: hostId, k: 'host_offline' })
    expect(alertPush?.body?.message?.data?.ct).toBeUndefined()

    // The unauthenticated socket is not yet due: the alarm must have been re-armed
    // for exactly its auth deadline
    const reArmed = await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) =>
      state.storage.getAlarm(),
    )
    expect(reArmed, 'the alarm must be re-armed for the unauthenticated socket deadline').toBe(pendingDeadline)

    // Running the re-armed alarm closes the socket with 4408
    const closePromise = nextClose(pendingWs)
    expect(await runAlarmAt(hub, pendingDeadline)).toBe(true)
    const closeEvent = await closePromise
    expect(closeEvent, 'the unauthenticated socket must be closed').not.toBeNull()
    expect(closeEvent?.code).toBe(CloseCodes.AUTH_TIMEOUT)
  })
})
