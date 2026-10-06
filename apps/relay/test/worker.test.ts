import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import {
  decodeBase32,
  decodeBase64Url,
  deriveEndpointId,
  encodeBase64Url,
  getRelayPublicKey,
  randomBytes,
  signRelayChallenge,
} from '@remora/crypto'
import {
  CloseCodes,
  DATA_FRAME_HEADER_BYTES,
  encodeDataFrame,
  PeerKind,
  RLY_SUBPROTOCOL,
} from '@remora/protocol'

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

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    if (ws.readyState === 3) {
      resolve({ code: CloseCodes.CLIENT_REPLACED, reason: 'already closed' })
      return
    }
    ws.addEventListener('close', (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason })
    })
  })
}

describe('Relay Worker & AccountHub Durable Object (workerd)', () => {
  const hostPriv = randomBytes(32)
  const hostPub = getRelayPublicKey(hostPriv)
  const hostId = deriveEndpointId('h_', hostPub)

  const devicePriv = randomBytes(32)
  const devicePub = getRelayPublicKey(devicePriv)
  const deviceId = deriveEndpointId('d_', devicePub)

  // Crypto/1 §4: the relay binds auth to the connection origin (the fetch URL
  // the DO sees), the endpoint identity and the challenge nonce.
  const RELAY_ORIGIN = 'https://relay.test'
  const signHostChallenge = (priv: Uint8Array, nonceB64u: string): Uint8Array =>
    signRelayChallenge(priv, { relayOrigin: RELAY_ORIGIN, kind: 'host', endpointId: hostId, nonce: decodeBase64Url(nonceB64u) })
  const signDeviceChallenge = (priv: Uint8Array, nonceB64u: string): Uint8Array =>
    signRelayChallenge(priv, { relayOrigin: RELAY_ORIGIN, kind: 'device', endpointId: deviceId, nonce: decodeBase64Url(nonceB64u) })

  let enrolledTicket = ''

  it('answers health checks without caching', async () => {
    const res = await SELF.fetch('https://relay.test/v1/health')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, v: 1 })
  })

  it('rejects unauthorized host enrollment', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/host', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad-secret' },
      body: JSON.stringify({ v: 1, relayPub: encodeBase64Url(hostPub), name: 'Host 1' }),
    })
    expect(res.status).toBe(401)
  })

  it('enrolls host with valid bearer secret', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/host', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-enroll-secret' },
      body: JSON.stringify({
        v: 1,
        relayPub: encodeBase64Url(hostPub),
        name: 'Workstation',
        platform: 'win32',
      }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { v: number; id: string }
    expect(data.v).toBe(1)
    expect(data.id).toBe(hostId)
  })

  it('host enrollment is idempotent', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/host', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-enroll-secret' },
      body: JSON.stringify({
        v: 1,
        relayPub: encodeBase64Url(hostPub),
        name: 'Workstation Renamed',
      }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { v: number; id: string }
    expect(data.id).toBe(hostId)
  })

  it('connects host websocket and authenticates with challenge signature', async () => {
    const res = await SELF.fetch('https://relay.test/v1/connect', {
      headers: {
        Upgrade: 'websocket',
        'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL,
      },
    })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()

    const challenge = await nextMessage<any>(ws)
    expect(challenge.t).toBe('challenge')
    expect(challenge.nonce).toBeDefined()

    const sig = signHostChallenge(hostPriv, challenge.nonce)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(sig),
        // RLY/1 §3 (issue #97 item 11): auth.app is an optional plain string,
        // not an object — the schema rejects anything else.
        app: 'remora-host/0.1.0',
      }),
    )

    const ready = await nextMessage<any>(ws)
    expect(ready.t).toBe('ready')
    expect(ready.id).toBe(hostId)
    expect(ready.peers).toEqual([])

    // Request an enrollment ticket
    ws.send(JSON.stringify({ t: 'enroll.ticket', rid: 'r1' }))
    const ticketOk = await nextMessage<any>(ws)
    expect(ticketOk.t).toBe('enroll.ticket.ok')
    expect(ticketOk.rid).toBe('r1')
    expect(ticketOk.ticket).toBeDefined()
    enrolledTicket = ticketOk.ticket

    ws.close(CloseCodes.NORMAL, 'bye')
  })

  it('rejects device enrollment with invalid ticket', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/device', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        ticket: encodeBase64Url(new Uint8Array(32).fill(0xee)),
        relayPub: encodeBase64Url(devicePub),
        name: 'Pixel 9',
      }),
    })
    expect(res.status).toBe(410)
    expect((await res.json()) as any).toMatchObject({ error: 'ticket_invalid' })
  })

  it('enrolls device with valid ticket and links to host', async () => {
    const res = await SELF.fetch('https://relay.test/v1/enroll/device', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        ticket: enrolledTicket,
        relayPub: encodeBase64Url(devicePub),
        name: 'Pixel 9',
        platform: 'android',
      }),
    })
    expect(res.status).toBe(200)
    const data = (await res.json()) as { v: number; id: string; hostId: string }
    expect(data.id).toBe(deviceId)
    expect(data.hostId).toBe(hostId)
  })

  it('rejects re-use of enrollment ticket', async () => {
    const otherPriv = randomBytes(32)
    const otherPub = getRelayPublicKey(otherPriv)
    const res = await SELF.fetch('https://relay.test/v1/enroll/device', {
      method: 'POST',
      body: JSON.stringify({
        v: 1,
        ticket: enrolledTicket,
        relayPub: encodeBase64Url(otherPub),
        name: 'Pixel 9 Second',
      }),
    })
    expect(res.status).toBe(410)
    expect((await res.json()) as any).toMatchObject({ error: 'ticket_invalid' })
  })

  it('routes binary data frames between linked endpoints with 17-byte header rewrite', async () => {
    // 1. Connect Host
    const hostRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const hostWs = hostRes.webSocket!
    hostWs.accept()
    const hostChallenge = await nextMessage<any>(hostWs)
    const hostSig = signHostChallenge(hostPriv, hostChallenge.nonce)
    hostWs.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(hostSig),
      }),
    )
    const hostReady = await nextMessage<any>(hostWs)
    expect(hostReady.t).toBe('ready')

    // 2. Connect Device
    const devRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const devWs = devRes.webSocket!
    devWs.accept()
    const devChallenge = await nextMessage<any>(devWs)
    const devSig = signDeviceChallenge(devicePriv, devChallenge.nonce)
    devWs.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: deviceId,
        kind: 'device',
        sig: encodeBase64Url(devSig),
      }),
    )
    const devReady = await nextMessage<any>(devWs)
    expect(devReady.t).toBe('ready')

    // Device received initial peers showing host online
    expect(devReady.peers.some((p: any) => p.id === hostId && p.online === true)).toBe(true)

    // Host receives presence frame for device coming online
    const devPresence = await nextMessage<any>(hostWs)
    expect(devPresence.t).toBe('presence')
    expect(devPresence.id).toBe(deviceId)
    expect(devPresence.online).toBe(true)

    // 3. Send binary data frame from Host to Device
    const randomPayload = randomBytes(128)
    const deviceRawId = decodeBase32(deviceId.slice(2))
    const frameToSend = encodeDataFrame({
      channel: 42,
      peerKind: PeerKind.DEVICE,
      peerId: deviceRawId,
      payload: randomPayload,
    })

    hostWs.send(frameToSend)

    // Device receives routed frame
    const receivedMsg = await nextMessage<ArrayBuffer>(devWs)
    expect(receivedMsg).toBeInstanceOf(ArrayBuffer)
    const receivedBytes = new Uint8Array(receivedMsg)

    // Verify 28-byte header rewrite:
    // Delivered by relay, peer is the SOURCE (host)
    expect(receivedBytes[8]).toBe(PeerKind.HOST)
    const hostRawId = decodeBase32(hostId.slice(2))
    expect(Array.from(receivedBytes.subarray(9, 25))).toEqual(Array.from(hostRawId))

    // Verify payload bytes beyond byte 28 are 100% identical!
    const receivedPayload = receivedBytes.subarray(DATA_FRAME_HEADER_BYTES)
    expect(Array.from(receivedPayload)).toEqual(Array.from(randomPayload))

    hostWs.close(CloseCodes.NORMAL, 'done')
    devWs.close(CloseCodes.NORMAL, 'done')
  })

  it('enforces newest-wins replacement (4409) on concurrent connections', async () => {
    // Connect first socket
    const res1 = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws1 = res1.webSocket!
    ws1.accept()
    const c1 = await nextMessage<any>(ws1)
    ws1.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signHostChallenge(hostPriv, c1.nonce)),
      }),
    )
    await nextMessage<any>(ws1)

    // Connect second socket for same host
    const res2 = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws2 = res2.webSocket!
    ws2.accept()
    const c2 = await nextMessage<any>(ws2)

    const closePromise = nextClose(ws1)

    ws2.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signHostChallenge(hostPriv, c2.nonce)),
      }),
    )
    await nextMessage<any>(ws2)

    // First socket must receive 4409 close
    const closeInfo = await closePromise
    expect(closeInfo.code).toBe(CloseCodes.CLIENT_REPLACED)

    ws2.close(CloseCodes.NORMAL, 'done')
  })

  it('rejects frame to offline peer with peer_offline error', async () => {
    const res = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const ws = res.webSocket!
    ws.accept()
    const c = await nextMessage<any>(ws)
    ws.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signHostChallenge(hostPriv, c.nonce)),
      }),
    )
    await nextMessage<any>(ws)

    // Send to offline device
    const deviceRawId = decodeBase32(deviceId.slice(2))
    const frameToSend = encodeDataFrame({
      channel: 1,
      peerKind: PeerKind.DEVICE,
      peerId: deviceRawId,
      payload: new Uint8Array([1, 2, 3]),
    })
    ws.send(frameToSend)

    const err = await nextMessage<any>(ws)
    expect(err.t).toBe('error')
    expect(err.code).toBe('peer_offline')

    ws.close(CloseCodes.NORMAL, 'done')
  })

  it('endpoint.revoke revokes device and closes active socket with 4403', async () => {
    // Connect device
    const devRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const devWs = devRes.webSocket!
    devWs.accept()
    const devC = await nextMessage<any>(devWs)
    devWs.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: deviceId,
        kind: 'device',
        sig: encodeBase64Url(signDeviceChallenge(devicePriv, devC.nonce)),
      }),
    )
    await nextMessage<any>(devWs)

    // Connect host
    const hostRes = await SELF.fetch('https://relay.test/v1/connect', {
      headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': RLY_SUBPROTOCOL },
    })
    const hostWs = hostRes.webSocket!
    hostWs.accept()
    const hostC = await nextMessage<any>(hostWs)
    hostWs.send(
      JSON.stringify({
        t: 'auth',
        v: 1,
        id: hostId,
        kind: 'host',
        sig: encodeBase64Url(signHostChallenge(hostPriv, hostC.nonce)),
      }),
    )
    await nextMessage<any>(hostWs)

    const devClosePromise = nextClose(devWs)

    // Host revokes device
    hostWs.send(JSON.stringify({ t: 'endpoint.revoke', rid: 'rev1', id: deviceId }))
    const ok = await nextMessage<any>(hostWs)
    expect(ok.t).toBe('ok')
    expect(ok.rid).toBe('rev1')

    // Device socket is closed with 4403
    const devClose = await devClosePromise
    expect(devClose.code).toBe(CloseCodes.FORBIDDEN)

    hostWs.close(CloseCodes.NORMAL, 'done')
  })
})
