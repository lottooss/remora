/**
 * AdversaryRelayProxy: an intercepting WebSocket proxy between endpoints and
 * the relay that can manipulate traffic (flip, drop, reorder, replay, splice)
 * to verify that security invariants and crypto fail closed.
 */
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { RLY_SUBPROTOCOL } from '@remora/protocol'

export type FrameDirection = 'upstream' | 'downstream'

export interface InterceptedFrame {
  id: number
  direction: FrameDirection
  isBinary: boolean
  data: Uint8Array | string
  timestamp: number
  mutated?: boolean
  dropped?: boolean
}

export type MutationRule = (
  frame: InterceptedFrame,
) => 'pass' | 'drop' | { action: 'modify'; data: Uint8Array | string } | { action: 'duplicate'; count: number } | { action: 'delay'; delayMs: number }

export interface AdversaryOptions {
  targetRelayUrl: string
  port?: number
}

export class AdversaryRelayProxy {
  private server: http.Server | null = null
  private wss: WebSocketServer | null = null
  private activeRules: MutationRule[] = []
  private trafficLog: InterceptedFrame[] = []
  private frameCounter = 0
  private openSockets = new Set<WebSocket>()

  readonly targetRelayUrl: string
  readonly port: number

  constructor(options: AdversaryOptions) {
    this.targetRelayUrl = options.targetRelayUrl
    this.port = options.port ?? 0
  }

  get proxyUrl(): string {
    if (!this.server) {
      throw new Error('Proxy not started')
    }
    const addr = this.server.address()
    if (!addr || typeof addr === 'string') {
      throw new Error('Server address not available')
    }
    return `ws://127.0.0.1:${addr.port}`
  }

  get log(): readonly InterceptedFrame[] {
    return this.trafficLog
  }

  clearLog(): void {
    this.trafficLog = []
  }

  addRule(rule: MutationRule): void {
    this.activeRules.push(rule)
  }

  clearRules(): void {
    this.activeRules = []
  }

  /**
   * Helper: drop the next N frames matching a predicate.
   */
  dropNext(predicate: (f: InterceptedFrame) => boolean, count = 1): void {
    let remaining = count
    this.addRule((f) => {
      if (remaining > 0 && predicate(f)) {
        remaining -= 1
        return 'drop'
      }
      return 'pass'
    })
  }

  /**
   * Helper: flip bits in payload of the next matching binary frame.
   */
  flipBitNext(predicate: (f: InterceptedFrame) => boolean, byteOffset: number, bitMask = 0x01): void {
    let fired = false
    this.addRule((f) => {
      if (!fired && f.isBinary && predicate(f)) {
        fired = true
        const uint8 = f.data instanceof Uint8Array ? f.data.slice() : new Uint8Array(Buffer.from(f.data))
        const current = uint8[byteOffset]
        if (current !== undefined) {
          uint8[byteOffset] = current ^ bitMask
        }
        return { action: 'modify', data: uint8 }
      }
      return 'pass'
    })
  }

  /**
   * Helper: duplicate/replay the next matching frame N times.
   */
  replayNext(predicate: (f: InterceptedFrame) => boolean, count = 1): void {
    let fired = false
    this.addRule((f) => {
      if (!fired && predicate(f)) {
        fired = true
        return { action: 'duplicate', count }
      }
      return 'pass'
    })
  }

  /**
   * Helper: splice or overwrite bytes at an offset.
   */
  spliceNext(
    predicate: (f: InterceptedFrame) => boolean,
    byteOffset: number,
    length: number,
    replacement: Uint8Array,
  ): void {
    let fired = false
    this.addRule((f) => {
      if (!fired && f.isBinary && predicate(f)) {
        fired = true
        const uint8 = f.data instanceof Uint8Array ? f.data : new Uint8Array(Buffer.from(f.data))
        const spliced = new Uint8Array(uint8.length - length + replacement.length)
        spliced.set(uint8.subarray(0, byteOffset), 0)
        spliced.set(replacement, byteOffset)
        spliced.set(uint8.subarray(byteOffset + length), byteOffset + replacement.length)
        return { action: 'modify', data: spliced }
      }
      return 'pass'
    })
  }

  async start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server = http.createServer()
      this.wss = new WebSocketServer({
        server: this.server,
        handleProtocols: (protocols) => {
          if (protocols.has(RLY_SUBPROTOCOL)) return RLY_SUBPROTOCOL
          return false
        },
      })

      this.wss.on('connection', (clientWs, req) => {
        this.openSockets.add(clientWs)
        const targetUrl = new URL(req.url ?? '/', this.targetRelayUrl)

        const upstreamWs = new WebSocket(targetUrl.toString(), [RLY_SUBPROTOCOL])
        this.openSockets.add(upstreamWs)

        const queuedUpstream: Array<{ data: any; isBinary: boolean }> = []

        clientWs.on('message', (data, isBinary) => {
          if (upstreamWs.readyState === WebSocket.OPEN) {
            this.handleFrame('upstream', clientWs, upstreamWs, data, isBinary)
          } else {
            queuedUpstream.push({ data, isBinary })
          }
        })

        upstreamWs.on('open', () => {
          for (const item of queuedUpstream) {
            this.handleFrame('upstream', clientWs, upstreamWs, item.data, item.isBinary)
          }
          queuedUpstream.length = 0
        })

        upstreamWs.on('message', (data, isBinary) => {
          this.handleFrame('downstream', upstreamWs, clientWs, data, isBinary)
        })

        clientWs.on('close', (code, reason) => {
          this.openSockets.delete(clientWs)
          if (upstreamWs.readyState === WebSocket.OPEN) {
            upstreamWs.close(code, reason)
          }
        })

        upstreamWs.on('close', (code, reason) => {
          this.openSockets.delete(upstreamWs)
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(code, reason)
          }
        })

        clientWs.on('error', () => {
          upstreamWs.close()
        })
        upstreamWs.on('error', () => {
          clientWs.close()
        })
      })

      this.server.listen(this.port, '127.0.0.1', () => {
        resolve()
      })
      this.server.on('error', reject)
    })
  }

  private handleFrame(
    direction: FrameDirection,
    _from: WebSocket,
    to: WebSocket,
    raw: unknown,
    isBinary: boolean,
  ): void {
    if (to.readyState !== WebSocket.OPEN) return

    const data: Uint8Array | string = isBinary
      ? raw instanceof Uint8Array
        ? raw
        : new Uint8Array(Buffer.from(raw as ArrayBuffer))
      : String(raw)

    const frame: InterceptedFrame = {
      id: ++this.frameCounter,
      direction,
      isBinary,
      data,
      timestamp: Date.now(),
    }

    let decision: ReturnType<MutationRule> = 'pass'
    for (const rule of this.activeRules) {
      decision = rule(frame)
      if (decision !== 'pass') break
    }

    if (decision === 'drop') {
      frame.dropped = true
      this.trafficLog.push(frame)
      return
    }

    if (typeof decision === 'object') {
      if (decision.action === 'modify') {
        frame.mutated = true
        frame.data = decision.data
        this.trafficLog.push(frame)
        to.send(decision.data, { binary: isBinary })
        return
      } else if (decision.action === 'duplicate') {
        this.trafficLog.push(frame)
        to.send(frame.data, { binary: isBinary })
        for (let i = 0; i < decision.count; i++) {
          to.send(frame.data, { binary: isBinary })
        }
        return
      } else if (decision.action === 'delay') {
        this.trafficLog.push(frame)
        setTimeout(() => {
          if (to.readyState === WebSocket.OPEN) {
            to.send(frame.data, { binary: isBinary })
          }
        }, decision.delayMs)
        return
      }
    }

    this.trafficLog.push(frame)
    to.send(frame.data, { binary: isBinary })
  }

  async close(): Promise<void> {
    for (const ws of this.openSockets) {
      try {
        ws.terminate()
      } catch {
        // ignore
      }
    }
    this.openSockets.clear()

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()))
      this.wss = null
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
  }
}
