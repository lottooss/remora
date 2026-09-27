import { env } from 'cloudflare:workers'
import { runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  deriveEndpointId,
  encodeBase64Url,
  getRelayPublicKey,
  randomBytes,
  signRelayChallenge,
} from '@remora/crypto'
import { CloseCodes, RLY_SUBPROTOCOL } from '@remora/protocol'
import type { AccountHub } from '../src/account-hub.ts'
import { resetFcmTokenCache } from '../src/fcm.ts'

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

describe('Relay push dispatch + host-offline alarm (RLY/1 §8, P5-R1)', () => {
  const originalFetch = globalThis.fetch
  const capturedFcmRequests: CapturedFcmRequest[] = []
  let fcmMockStatus = 200
  let fcmMockBody: any = { name: 'projects/remora-test-proj/messages/msg_001' }

  const hostPriv = randomBytes(32)
  const hostPub = getRelayPublicKey(hostPriv)
  const hostId = deriveEndpointId('h_', hostPub)

  const devicePriv = randomBytes(32)
  const devicePub = getRelayPublicKey(devicePriv)
  const deviceId = deriveEndpointId('d_', devicePub)

  let enrolledTicket = ''

  beforeAll(async () => {
    // Set test configuration on environment
    ;(env as any).FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'remora-test-proj',
      client_email: 'remora-test@remora-test-proj.iam.gserviceaccount.com',
      private_key: 'dummy-test-key',
    })
    ;(env as any).FCM_ENDPOINT = 'https://fake-fcm.googleapis.com'
    ;(env as any).HOST_OFFLINE_ALERT_MS = '100'

    // Mock global fetch for fake FCM endpoint
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
        name: 'PushTestHost',
        platform: 'win32',
      }),
    })
    expect(hostRes.status).toBe(200)

    // Connect host to get enrollment ticket
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const challenge = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, challenge.nonce)),
      }),
    )
    await nextMessage<any>(ws) // ready

    ws.send(JSON.stringify({ t: 'enroll.ticket', rid: 'tk1' }))
    const ticketMsg = await nextMessage<any>(ws)
    enrolledTicket = ticketMsg.ticket
    ws.close(CloseCodes.NORMAL, 'setup complete')

    // Enroll device with ticket
    const devRes = await SELF.fetch('https://relay.test/v1/enroll/device', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        ticket: enrolledTicket,
        relayPub: encodeBase64Url(devicePub),
        name: 'PushTestDevice',
        platform: 'android',
      }),
    })
    expect(devRes.status).toBe(200)
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    capturedFcmRequests.length = 0
    fcmMockStatus = 200
    fcmMockBody = { name: 'projects/remora-test-proj/messages/msg_001' }
    resetFcmTokenCache()
  })

  it('registers FCM push token with hostOffline preference', async () => {
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const c = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: deviceId,
        kind: 'device',
        sig: encodeBase64Url(signRelayChallenge(devicePriv, c.nonce)),
      }),
    )
    await nextMessage<any>(ws) // ready

    // Send push.token with hostOffline: true
    ws.send(
      JSON.stringify({
        t: 'push.token',
        rid: 'pt1',
        token: 'fcm_token_device_abc_123',
        hostOffline: true,
      }),
    )
    const reply = await nextMessage<any>(ws)
    expect(reply.t).toBe('ok')
    expect(reply.rid).toBe('pt1')

    ws.close(CloseCodes.NORMAL, 'token test done')

    // Verify persisted in SQLite
    const hub = getAccountHubStub()
    await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) => {
      const rows = state.storage.sql
        .exec<{ fcm_token: string; host_offline: number }>('SELECT fcm_token, host_offline FROM endpoints WHERE id = ?1', deviceId)
        .toArray()
      expect(rows[0]?.fcm_token).toBe('fcm_token_device_abc_123')
      expect(rows[0]?.host_offline).toBe(1)
    })
  })

  it('dispatches push message from host to device with byte-identical ciphertext', async () => {
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const c = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c.nonce)),
      }),
    )
    await nextMessage<any>(ws) // ready

    const testCiphertext = 'E2E_CIPHERTEXT_1234567890_!@#$%^&*()_+~`|}{[]:;?><,./'
    ws.send(
      JSON.stringify({
        t: 'push',
        rid: 'push1',
        to: [deviceId],
        ct: testCiphertext,
        collapse: 'session_update',
        priority: 'high',
        ttl: 3600,
      }),
    )

    const pushResult = await nextMessage<any>(ws)
    expect(pushResult.t).toBe('push.result')
    expect(pushResult.rid).toBe('push1')
    expect(pushResult.results).toEqual([{ id: deviceId, status: 'sent' }])

    // Verify captured FCM HTTP v1 request
    expect(capturedFcmRequests.length).toBe(1)
    const req = capturedFcmRequests[0]!
    expect(req.url).toContain('/v1/projects/remora-test-proj/messages:send')
    expect(req.body.message.token).toBe('fcm_token_device_abc_123')

    // Invariant: ct is byte-identical and never decrypted or altered
    expect(req.body.message.data.ct).toBe(testCiphertext)
    expect(req.body.message.data.h).toBe(hostId)
    expect(req.body.message.data.v).toBe('1')

    // Android push configuration
    expect(req.body.message.android.priority).toBe('high')
    expect(req.body.message.android.ttl).toBe('3600s')
    expect(req.body.message.android.collapse_key).toBe('session_update')

    ws.close(CloseCodes.NORMAL, 'push done')
  })

  it('returns no_token when pushing to unlinked or tokenless endpoint', async () => {
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const c = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c.nonce)),
      }),
    )
    await nextMessage<any>(ws) // ready

    // Target unlinked device
    ws.send(
      JSON.stringify({
        t: 'push',
        rid: 'push_unlinked',
        to: ['d_unlinked000000000000000000000'],
        ct: 'some-ciphertext',
      }),
    )
    const resUnlinked = await nextMessage<any>(ws)
    expect(resUnlinked.results).toEqual([{ id: 'd_unlinked000000000000000000000', status: 'no_token' }])

    ws.close(CloseCodes.NORMAL, 'unlinked test done')
  })

  it('cleans up token and reports unregistered on FCM UNREGISTERED response', async () => {
    fcmMockStatus = 404
    fcmMockBody = {
      error: {
        code: 404,
        message: 'Requested entity was not found.',
        status: 'UNREGISTERED',
      },
    }

    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = connRes.webSocket!
    ws.accept()
    const c = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c.nonce)),
      }),
    )
    await nextMessage<any>(ws) // ready

    ws.send(
      JSON.stringify({
        t: 'push',
        rid: 'push_cleanup',
        to: [deviceId],
        ct: 'test-ct',
      }),
    )
    const result = await nextMessage<any>(ws)
    expect(result.t).toBe('push.result')
    expect(result.results).toEqual([{ id: deviceId, status: 'unregistered' }])

    ws.close(CloseCodes.NORMAL, 'cleanup test done')

    // Verify token was cleared from SQLite
    const hub = getAccountHubStub()
    await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) => {
      const rows = state.storage.sql
        .exec<{ fcm_token: string | null }>('SELECT fcm_token FROM endpoints WHERE id = ?1', deviceId)
        .toArray()
      expect(rows[0]?.fcm_token).toBeNull()
    })
  })

  it('arms DO alarm on host disconnect and fires host_offline alert push', async () => {
    // Re-register push token with hostOffline: true
    const hub = getAccountHubStub()
    await runInDurableObject(hub, (_instance: AccountHub, state: DurableObjectState) => {
      state.storage.sql.exec(
        'UPDATE endpoints SET fcm_token = ?1, host_offline = 1 WHERE id = ?2',
        'fcm_token_device_abc_123',
        deviceId,
      )
    })

    // Connect host
    const connRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const hostWs = connRes.webSocket!
    hostWs.accept()
    const c = await nextMessage<any>(hostWs)
    hostWs.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c.nonce)),
      }),
    )
    await nextMessage<any>(hostWs) // ready

    // Disconnect host (closes last socket) -> arms alarm
    hostWs.close(CloseCodes.NORMAL, 'host going offline')
    await new Promise((r) => setTimeout(r, 150))
    if (capturedFcmRequests.length === 0) {
      await runDurableObjectAlarm(hub)
    }

    // Verify metadata-only FCM push was dispatched
    expect(capturedFcmRequests.length).toBe(1)
    const alertPush = capturedFcmRequests[0]!
    expect(alertPush.body.message.token).toBe('fcm_token_device_abc_123')
    expect(alertPush.body.message.data).toEqual({
      v: '1',
      h: hostId,
      k: 'host_offline',
    })
    // Metadata only — no ct field
    expect(alertPush.body.message.data.ct).toBeUndefined()
  })

  it('cancels host-offline alarm if host reconnects before alarm fires', async () => {
    const hub = getAccountHubStub()

    // Connect host
    const connRes1 = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const hostWs1 = connRes1.webSocket!
    hostWs1.accept()
    const c1 = await nextMessage<any>(hostWs1)
    hostWs1.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c1.nonce)),
      }),
    )
    await nextMessage<any>(hostWs1) // ready

    // Close host -> arms alarm
    hostWs1.close(CloseCodes.NORMAL, 'temporary disconnect')

    // Host quickly reconnects
    const connRes2 = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const hostWs2 = connRes2.webSocket!
    hostWs2.accept()
    const c2 = await nextMessage<any>(hostWs2)
    hostWs2.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signRelayChallenge(hostPriv, c2.nonce)),
      }),
    )
    await nextMessage<any>(hostWs2) // ready -> cancels offline task & alarm

    // Alarm should not run or should find task cancelled
    const alarmRan = await runDurableObjectAlarm(hub)
    expect(alarmRan).toBe(false)
    expect(capturedFcmRequests.length).toBe(0)

    hostWs2.close(CloseCodes.NORMAL, 'done')
  })
})
