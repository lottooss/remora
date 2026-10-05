import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import {
  CloseCodes,
  decodeDataFrame,
  encodeDataFrame,
  PeerKind,
  RLY_SUBPROTOCOL,
  RLY_VERSION,
  type DataFrame,
  type Peer,
} from '@remora/protocol'
import { decodeBase64Url, encodeBase64Url, signRelayChallenge } from '@remora/crypto'

export type RelayLinkState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'backoff' | 'stopped'

export interface RelayLinkOptions {
  url: string
  endpointId: string
  endpointKind: 'host' | 'device'
  relayPrivateKey: Uint8Array
  appVersion?: string
  WebSocketClass?: typeof WebSocket | typeof globalThis.WebSocket
  reconnect?: boolean
  minBackoffMs?: number
  maxBackoffMs?: number
  pingIntervalMs?: number
  deadPeerTimeoutMs?: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  timer: NodeJS.Timeout
}

export type { DataFrame, Peer }

export class RelayLink extends EventEmitter {
  private stateVal: RelayLinkState = 'idle'
  private ws: any = null
  private peersVal: Peer[] = []
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private deadPeerTimer: NodeJS.Timeout | null = null
  private currentBackoffMs: number
  private pendingRequests = new Map<string, PendingRequest>()
  private stopped = false

  readonly options: Required<RelayLinkOptions>

  constructor(options: RelayLinkOptions) {
    super()
    this.options = {
      url: options.url,
      endpointId: options.endpointId,
      endpointKind: options.endpointKind,
      relayPrivateKey: options.relayPrivateKey,
      appVersion: options.appVersion ?? '0.1.0',
      WebSocketClass: options.WebSocketClass ?? (WebSocket as any),
      reconnect: options.reconnect ?? true,
      minBackoffMs: options.minBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      pingIntervalMs: options.pingIntervalMs ?? 25_000,
      deadPeerTimeoutMs: options.deadPeerTimeoutMs ?? 60_000,
    }
    this.currentBackoffMs = this.options.minBackoffMs
  }

  get state(): RelayLinkState {
    return this.stateVal
  }

  get peers(): Peer[] {
    return [...this.peersVal]
  }

  get bufferedAmount(): number {
    return this.ws ? (this.ws.bufferedAmount ?? 0) : 0
  }

  start(): void {
    if (this.stopped) return
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimers()
    this.rejectAllPending(new Error('RelayLink stopped'))

    if (this.ws) {
      const socket = this.ws
      this.ws = null
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ t: 'bye', reason: 'shutdown' }))
        }
        socket.close(CloseCodes.NORMAL, 'shutdown')
      } catch {
        // ignore errors on closing socket
      }
    }
    this.setState('stopped')
  }

  sendData(destination: { peerKind: PeerKind; peerId: Uint8Array }, channel: number, payload: Uint8Array): void {
    if (this.stateVal !== 'ready' || !this.ws) {
      throw new Error(`Cannot send data frame in state ${this.stateVal}`)
    }
    const frame = encodeDataFrame({
      channel,
      peerKind: destination.peerKind,
      peerId: destination.peerId,
      payload,
    })
    this.ws.send(frame)
  }

  async request<T = unknown>(frame: { t: string; rid?: string; [key: string]: unknown }, timeoutMs = 10_000): Promise<T> {
    if (this.stateVal !== 'ready' || !this.ws) {
      throw new Error(`Cannot send request in state ${this.stateVal}`)
    }
    const rid = frame.rid ?? `r_${Math.random().toString(36).slice(2, 10)}`
    const wireFrame = { ...frame, rid }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(rid)
        reject(new Error(`Relay request ${wireFrame.t} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(rid, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      try {
        this.ws.send(JSON.stringify(wireFrame))
      } catch (err) {
        clearTimeout(timer)
        this.pendingRequests.delete(rid)
        reject(err)
      }
    })
  }

  private connect(): void {
    if (this.stopped) return
    this.setState('connecting')

    try {
      const WS = this.options.WebSocketClass
      this.ws = new WS(this.options.url, [RLY_SUBPROTOCOL])
      if ('binaryType' in this.ws) {
        this.ws.binaryType = 'arraybuffer'
      }

      this.ws.onopen = () => {
        // Connected; waiting for challenge from relay
      }

      this.ws.onmessage = (event: { data: string | ArrayBuffer | Buffer }) => {
        this.handleMessage(event.data)
      }

      this.ws.onerror = (err: unknown) => {
        this.emit('error', err)
      }

      this.ws.onclose = (event: { code: number; reason?: string }) => {
        this.handleClose(event.code, event.reason)
      }
    } catch (err) {
      this.emit('error', err)
      this.scheduleReconnect()
    }
  }

  private handleMessage(data: string | ArrayBuffer | Buffer | Uint8Array): void {
    if (typeof data === 'string') {
      try {
        const frame = JSON.parse(data)
        this.handleControlFrame(frame)
      } catch (err) {
        this.emit('error', new Error(`Failed to parse control frame: ${err}`))
      }
    } else if (data && typeof data === 'object' && 'byteLength' in data) {
      let uint8: Uint8Array
      const anyData = data as any
      if (anyData instanceof Uint8Array) {
        uint8 = anyData
      } else if (anyData instanceof ArrayBuffer) {
        uint8 = new Uint8Array(anyData)
      } else {
        uint8 = new Uint8Array(anyData.buffer, anyData.byteOffset, anyData.byteLength)
      }

      try {
        const frame = decodeDataFrame(uint8)
        this.emit('data', frame)
      } catch (err) {
        this.emit('error', new Error(`Failed to decode data frame: ${err}`))
      }
    }
  }

  private handleControlFrame(frame: any): void {
    // Reset dead peer timer on any control frame received
    this.resetDeadPeerTimer()

    switch (frame.t) {
      case 'challenge': {
        this.setState('authenticating')
        const nonce = frame.nonce
        const relayUrl = new URL(this.options.url)
        relayUrl.protocol = relayUrl.protocol === 'wss:' ? 'https:' : 'http:'
        const sig = signRelayChallenge(this.options.relayPrivateKey, {
          relayOrigin: relayUrl.origin,
          kind: this.options.endpointKind,
          endpointId: this.options.endpointId,
          nonce: decodeBase64Url(nonce),
        })
        const b64uSig = encodeBase64Url(sig)

        const authPayload = {
          t: 'auth',
          v: RLY_VERSION,
          kind: this.options.endpointKind,
          id: this.options.endpointId,
          sig: b64uSig,
          app: this.options.appVersion,
        }
        if (this.ws) {
          this.ws.send(JSON.stringify(authPayload))
        }
        break
      }

      case 'ready': {
        this.peersVal = frame.peers ?? []
        this.currentBackoffMs = this.options.minBackoffMs
        this.setState('ready')
        this.startHeartbeat()
        this.emit('ready', this.peersVal, frame.limits)
        break
      }

      case 'presence': {
        const existing = this.peersVal.find((p) => p.id === frame.id)
        if (existing) {
          existing.online = frame.online
          existing.lastSeenAt = frame.at
        } else {
          this.peersVal.push({
            id: frame.id,
            kind: frame.kind,
            name: frame.name ?? frame.id,
            online: frame.online,
            lastSeenAt: frame.at,
          })
        }
        this.emit('presence', frame)
        break
      }

      case 'pong': {
        // Keepalive acknowledged
        break
      }

      case 'error': {
        if (frame.rid && this.pendingRequests.has(frame.rid)) {
          const pending = this.pendingRequests.get(frame.rid)!
          clearTimeout(pending.timer)
          this.pendingRequests.delete(frame.rid)
          pending.reject(new Error(`Relay error ${frame.code}: ${frame.message}`))
        } else {
          this.emit('error', new Error(`Relay error: ${frame.code} - ${frame.message}`))
        }
        break
      }

      default: {
        // Response with matching rid
        if (frame.rid && this.pendingRequests.has(frame.rid)) {
          const pending = this.pendingRequests.get(frame.rid)!
          clearTimeout(pending.timer)
          this.pendingRequests.delete(frame.rid)
          pending.resolve(frame)
        }
      }
    }
  }

  private handleClose(code: number, reason?: string): void {
    this.clearTimers()
    this.rejectAllPending(new Error(`Socket closed (${code}: ${reason ?? ''})`))
    this.ws = null

    if (this.stopped) return

    // Don't reconnect on fatal authorization failure
    if (code === CloseCodes.AUTH_FAILED || code === CloseCodes.FORBIDDEN) {
      this.setState('idle')
      this.emit('error', new Error(`Permanent auth failure from relay (${code})`))
      return
    }

    if (code === CloseCodes.CLIENT_REPLACED) {
      this.setState('idle')
      this.emit('error', new Error('Relay connection replaced by another client (4409)'))
      return
    }

    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.options.reconnect) return
    this.setState('backoff')

    // Full jitter exponential backoff: random between 0 and currentBackoff
    const jittered = Math.floor(Math.random() * this.currentBackoffMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, jittered)

    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.options.maxBackoffMs)
  }

  private startHeartbeat(): void {
    this.clearHeartbeat()
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ t: 'ping' }))
      }
    }, this.options.pingIntervalMs)
    this.resetDeadPeerTimer()
  }

  private resetDeadPeerTimer(): void {
    if (this.deadPeerTimer) clearTimeout(this.deadPeerTimer)
    this.deadPeerTimer = setTimeout(() => {
      // No frames received within deadPeerTimeoutMs; force reconnect
      if (this.ws) {
        try {
          this.ws.close(CloseCodes.AUTH_TIMEOUT, 'dead peer')
        } catch {
          // ignore
        }
      }
    }, this.options.deadPeerTimeoutMs)
  }

  private clearHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.deadPeerTimer) {
      clearTimeout(this.deadPeerTimer)
      this.deadPeerTimer = null
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pendingRequests.clear()
  }

  private setState(state: RelayLinkState): void {
    if (this.stateVal === state) return
    this.stateVal = state
    this.emit('state', state)
  }
}
