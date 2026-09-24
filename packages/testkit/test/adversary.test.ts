import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { RLY_SUBPROTOCOL } from '@remora/protocol'
import { AdversaryRelayProxy } from '../src/adversary.ts'

describe('AdversaryRelayProxy', () => {
  let targetServer: http.Server | null = null
  let targetWss: WebSocketServer | null = null
  let targetPort = 0
  let proxy: AdversaryRelayProxy | null = null

  afterEach(async () => {
    if (proxy) {
      await proxy.close()
      proxy = null
    }
    if (targetWss) {
      await new Promise<void>((r) => targetWss!.close(() => r()))
      targetWss = null
    }
    if (targetServer) {
      await new Promise<void>((r) => targetServer!.close(() => r()))
      targetServer = null
    }
  })

  async function startTargetServer(): Promise<number> {
    return new Promise((resolve) => {
      targetServer = http.createServer()
      targetWss = new WebSocketServer({
        server: targetServer,
        handleProtocols: () => RLY_SUBPROTOCOL,
      })
      targetServer.listen(0, '127.0.0.1', () => {
        targetPort = (targetServer!.address() as any).port
        resolve(targetPort)
      })
    })
  }

  it('proxies frames and logs traffic', async () => {
    const port = await startTargetServer()

    targetWss!.on('connection', (ws) => {
      ws.on('message', (msg) => {
        ws.send(`echo:${msg}`)
      })
    })

    proxy = new AdversaryRelayProxy({ targetRelayUrl: `ws://127.0.0.1:${port}` })
    await proxy.start()

    const client = new WebSocket(proxy.proxyUrl, [RLY_SUBPROTOCOL])
    await new Promise<void>((r) => client.on('open', () => r()))

    const replyPromise = new Promise<string>((r) => client.on('message', (m) => r(String(m))))
    client.send('ping')
    const reply = await replyPromise
    expect(reply).toBe('echo:ping')

    expect(proxy.log.length).toBeGreaterThanOrEqual(2)
    client.close()
  })

  it('drops frames matching rule', async () => {
    const port = await startTargetServer()

    targetWss!.on('connection', (ws) => {
      ws.on('message', (msg) => {
        ws.send(`echo:${msg}`)
      })
    })

    proxy = new AdversaryRelayProxy({ targetRelayUrl: `ws://127.0.0.1:${port}` })
    proxy.dropNext((f) => String(f.data).includes('drop-me'))
    await proxy.start()

    const client = new WebSocket(proxy.proxyUrl, [RLY_SUBPROTOCOL])
    await new Promise<void>((r) => client.on('open', () => r()))

    client.send('drop-me')
    // Wait briefly to confirm no echo received
    let received = false
    client.on('message', () => {
      received = true
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(received).toBe(false)

    // Next message passes
    const replyPromise = new Promise<string>((r) => client.once('message', (m) => r(String(m))))
    client.send('pass-me')
    const reply = await replyPromise
    expect(reply).toBe('echo:pass-me')

    client.close()
  })

  it('flips bits in binary frame', async () => {
    const port = await startTargetServer()

    const receivedPromise = new Promise<Uint8Array>((resolve) => {
      targetWss!.on('connection', (ws) => {
        ws.on('message', (msg: any) => {
          resolve(new Uint8Array(msg))
        })
      })
    })

    proxy = new AdversaryRelayProxy({ targetRelayUrl: `ws://127.0.0.1:${port}` })
    proxy.flipBitNext(() => true, 0, 0xff)
    await proxy.start()

    const client = new WebSocket(proxy.proxyUrl, [RLY_SUBPROTOCOL])
    await new Promise<void>((r) => client.on('open', () => r()))

    const testPayload = new Uint8Array([0x00, 0x01, 0x02])
    client.send(testPayload)

    const receivedBytes = await receivedPromise
    expect(receivedBytes[0]).toBe(0xff) // flipped from 0x00
    expect(receivedBytes[1]).toBe(0x01) // untouched

    client.close()
  })
})
