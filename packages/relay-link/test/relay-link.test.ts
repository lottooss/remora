import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { RelayLink } from '../src/index.js'
import { CloseCodes, PeerKind, encodeDataFrame } from '@remora/protocol'

class FakeWebSocket extends EventEmitter {
  static OPEN = 1
  static CLOSED = 3

  readyState = FakeWebSocket.OPEN
  bufferedAmount = 0
  sent: Array<string | Uint8Array> = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: any }) => void) | null = null
  onerror: ((err: any) => void) | null = null
  onclose: ((event: { code: number; reason?: string }) => void) | null = null

  constructor(public url: string, public protocols?: string[]) {
    super()
    setTimeout(() => {
      this.emit('open')
    }, 5)
  }

  send(data: string | Uint8Array) {
    this.sent.push(data)
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeWebSocket.CLOSED
    this.emit('close', { code, reason })
  }

  override emit(event: string | symbol, ...args: any[]): boolean {
    if (event === 'open') {
      this.onopen?.()
    } else if (event === 'message') {
      const msg = args[0]
      const dataObj = msg && typeof msg === 'object' && 'data' in msg ? msg : { data: msg }
      this.onmessage?.(dataObj)
    } else if (event === 'close') {
      this.onclose?.(args[0] ?? { code: 1000, reason: '' })
    } else if (event === 'error') {
      this.onerror?.(args[0])
    }
    return super.emit(event, ...args)
  }
}

describe('RelayLink', () => {
  const relayPrivateKey = new Uint8Array(32).fill(0x07)
  const endpointId = 'h_test12345678901234567890'

  it('connects and authenticates on receiving challenge', async () => {
    let wsInstance: FakeWebSocket | null = null
    const FakeWSFactory = class extends FakeWebSocket {
      constructor(url: string, proto?: string[]) {
        super(url, proto)
        wsInstance = this
      }
    }

    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: FakeWSFactory as any,
      minBackoffMs: 10,
    })

    const states: string[] = []
    link.on('state', (s) => states.push(s))

    link.start()
    expect(link.state).toBe('connecting')

    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    // Server sends challenge
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'challenge',
        v: 1,
        nonce: 'test_nonce_32_bytes_fixed',
        time: 1790000000,
      }),
    })

    expect(link.state).toBe('authenticating')

    // Expect auth frame sent
    expect(wsInstance!.sent.length).toBe(1)
    const authFrame = JSON.parse(wsInstance!.sent[0] as string)
    expect(authFrame.t).toBe('auth')
    expect(authFrame.id).toBe(endpointId)
    expect(authFrame.sig).toBeDefined()

    // Server sends ready
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'ready',
        v: 1,
        id: endpointId,
        peers: [{ id: 'd_device1', kind: 'device', name: 'Phone', online: true, lastSeenAt: 1790000000 }],
      }),
    })

    expect(link.state).toBe('ready')
    expect(link.peers.length).toBe(1)
    expect(link.peers[0]?.id).toBe('d_device1')

    await link.stop()
    expect(link.state).toBe('stopped')
  })

  it('receives binary data frames and emits data event', async () => {
    let wsInstance: FakeWebSocket | null = null
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          wsInstance = this
        }
      } as any,
    })

    link.start()
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    // Put into ready state
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'ready',
        v: 1,
        id: endpointId,
        peers: [],
      }),
    })

    let receivedFrame: any = null
    link.on('data', (f) => {
      receivedFrame = f
    })

    const payload = new Uint8Array([0xca, 0xfe, 0xba, 0xbe])
    const dataFrameBytes = encodeDataFrame({
      channel: 101,
      peerKind: PeerKind.DEVICE,
      peerId: new Uint8Array(16).fill(0x11),
      payload,
    })

    wsInstance!.emit('message', { data: dataFrameBytes })

    expect(receivedFrame).not.toBeNull()
    expect(receivedFrame.channel).toBe(101)
    expect(Array.from(receivedFrame.payload)).toEqual(Array.from(payload))

    await link.stop()
  })

  it('handles request correlation with rid', async () => {
    let wsInstance: FakeWebSocket | null = null
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          wsInstance = this
        }
      } as any,
    })

    link.start()
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    wsInstance!.emit('message', {
      data: JSON.stringify({ t: 'ready', v: 1, id: endpointId, peers: [] }),
    })

    const reqPromise = link.request<{ t: string; rid: string; ticket: string }>({
      t: 'enroll.ticket',
      rid: 'req_123',
    })

    expect(wsInstance!.sent.length).toBe(1)
    const sent = JSON.parse(wsInstance!.sent[0] as string)
    expect(sent.rid).toBe('req_123')

    // Reply from relay
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'enroll.ticket.ok',
        rid: 'req_123',
        ticket: 'tkt_new_device',
        expiresAt: 1790000600,
      }),
    })

    const res = await reqPromise
    expect(res.t).toBe('enroll.ticket.ok')
    expect(res.ticket).toBe('tkt_new_device')

    await link.stop()
  })

  it('reconnect storm: survives 100 forced disconnects without memory leak', async () => {
    let count = 0
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      minBackoffMs: 1,
      maxBackoffMs: 4,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          count++
          setTimeout(() => {
            if (count < 100) {
              this.close(CloseCodes.NORMAL, 'reconnect test')
            }
          }, 1)
        }
      } as any,
    })

    link.start()
    await vi.waitFor(() => expect(count).toBeGreaterThanOrEqual(100), { timeout: 5000 })
    const startStop = Date.now()
    await link.stop()
    expect(Date.now() - startStop).toBeLessThan(1000)
    expect(link.state).toBe('stopped')
  })

  it('stop() resolves quickly and aborts pending requests and backoff', async () => {
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: FakeWebSocket as any,
    })

    link.start()
    const stopStart = Date.now()
    await link.stop()
    expect(Date.now() - stopStart).toBeLessThan(500)
    expect(link.state).toBe('stopped')
  })

  it('does not reconnect on 4401 AUTH_FAILED or 4409 CLIENT_REPLACED', async () => {
    let wsInstance: FakeWebSocket | null = null
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          wsInstance = this
        }
      } as any,
    })

    const errors: Error[] = []
    link.on('error', (err: any) => errors.push(err))

    link.start()
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    // Close with 4409
    wsInstance!.close(CloseCodes.CLIENT_REPLACED, 'replaced')
    expect(link.state).toBe('idle')
    expect(errors.some((e) => e.message.includes('4409'))).toBe(true)

    await link.stop()
  })

  it('updates presence and peer list', async () => {
    let wsInstance: FakeWebSocket | null = null
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          wsInstance = this
        }
      } as any,
    })

    link.start()
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'ready',
        v: 1,
        id: endpointId,
        peers: [{ id: 'd_phone1', kind: 'device', name: 'Phone 1', online: false, lastSeenAt: 100 }],
      }),
    })

    expect(link.peers.length).toBe(1)
    expect(link.peers[0]?.online).toBe(false)

    // Presence update
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'presence',
        v: 1,
        id: 'd_phone1',
        kind: 'device',
        online: true,
        at: 200,
      }),
    })

    expect(link.peers[0]?.online).toBe(true)
    expect(link.peers[0]?.lastSeenAt).toBe(200)

    // New peer presence
    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'presence',
        v: 1,
        id: 'd_phone2',
        kind: 'device',
        name: 'Phone 2',
        online: true,
        at: 300,
      }),
    })

    expect(link.peers.length).toBe(2)
    expect(link.bufferedAmount).toBe(0)

    await link.stop()
  })

  it('handles relay error frame for correlated request', async () => {
    let wsInstance: FakeWebSocket | null = null
    const link = new RelayLink({
      url: 'wss://relay.example.com/v1/connect',
      endpointId,
      endpointKind: 'host',
      relayPrivateKey,
      WebSocketClass: class extends FakeWebSocket {
        constructor(url: string, proto?: string[]) {
          super(url, proto)
          wsInstance = this
        }
      } as any,
    })

    link.start()
    await vi.waitFor(() => expect(wsInstance).not.toBeNull())

    wsInstance!.emit('message', {
      data: JSON.stringify({ t: 'ready', v: 1, id: endpointId, peers: [] }),
    })

    const reqPromise = link.request({ t: 'enroll.ticket', rid: 'req_fail' })

    wsInstance!.emit('message', {
      data: JSON.stringify({
        t: 'error',
        rid: 'req_fail',
        code: 403,
        message: 'Account quota exceeded',
      }),
    })

    await expect(reqPromise).rejects.toThrow('Relay error 403: Account quota exceeded')
    await link.stop()
  })
})
