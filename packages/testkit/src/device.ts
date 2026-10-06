/**
 * FakeDevice: testkit phone implementation speaking RLY/1 + SC/1 + RCP/1.
 * Simulates an Android client connecting through the relay and establishing
 * Noise IKpsk2 secure channels with Remora hosts.
 */
import {
  concatBytes,
  createInitiatorHandshake,
  decodeBase32,
  decodeBase64Url,
  deriveEndpointId,
  derivePairPsk,
  deriveSasCode,
  encodeBase64Url,
  generateKeypair,
  getRelayPublicKey,
  parsePairingQr,
  randomBytes,
  utf8ToBytes,
  type CipherState,
  type Keypair,
} from '@remora/crypto'
import {
  HelloResultSchema,
  HostStatusResultSchema,
  PeerKind,
  RCP_VERSION,
  type DataFrame,
} from '@remora/protocol'
import { RelayLink, type RelayLinkState } from '@remora/relay-link'

export const RECORD_TYPE = {
  HANDSHAKE_MSG1: 0x01,
  HANDSHAKE_MSG2: 0x02,
  TRANSPORT: 0x03,
} as const

export interface FakeDeviceOptions {
  relayKeypair?: Keypair
  noiseKeypair?: Keypair
  devicePsk?: Uint8Array
  name?: string
}

export interface FakeChannelOptions {
  hostId: string
  hostNoisePublicKey: Uint8Array
  channelId?: number
  timeoutMs?: number
}

const EMPTY_AAD = new Uint8Array(0)

export class FakeDeviceChannel {
  private nextRequestId = 1
  private pendingRequests = new Map<number, {
    resolve: (res: any) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()
  private streamListeners = new Map<number, (item: any) => void>()
  private streamEndListeners = new Map<number, (ok: boolean, err?: any) => void>()
  private streamBuffers = new Map<number, any[]>()
  private streamEndBuffers = new Map<number, { ok: boolean; err?: any }>()

  constructor(
    readonly channelId: number,
    readonly hostId: string,
    readonly hostRawId: Uint8Array,
    readonly sendCipher: CipherState,
    readonly recvCipher: CipherState,
    readonly handshakeHash: Uint8Array,
    private readonly sendFrame: (payload: Uint8Array) => void,
  ) {}

  /**
   * Dispatches incoming decrypted transport payload to pending RCP callers.
   */
  handleTransportPayload(payload: Uint8Array): void {
    let jsonStr: string
    try {
      const plaintext = this.recvCipher.decryptWithAd(EMPTY_AAD, payload)
      jsonStr = new TextDecoder().decode(plaintext)
    } catch {
      // Noise decryption failure
      return
    }

    try {
      const envelope = JSON.parse(jsonStr)
      if (envelope && typeof envelope === 'object') {
        if (typeof envelope.id === 'number') {
          const pending = this.pendingRequests.get(envelope.id)
          if (pending) {
            clearTimeout(pending.timer)
            this.pendingRequests.delete(envelope.id)
            if (envelope.ok === false && envelope.e) {
              const err = new Error(envelope.e.message ?? 'RCP error')
              ;(err as any).code = envelope.e.code
              ;(err as any).details = envelope.e.details
              pending.reject(err)
            } else {
              pending.resolve(envelope.r)
            }
          }
        }
        if (envelope.k === 'item' && typeof envelope.sid === 'number') {
          const listener = this.streamListeners.get(envelope.sid)
          if (listener) {
            listener(envelope.d)
          } else {
            const buf = this.streamBuffers.get(envelope.sid) ?? []
            buf.push(envelope.d)
            this.streamBuffers.set(envelope.sid, buf)
          }
        }
        if (envelope.k === 'end' && typeof envelope.sid === 'number') {
          const endListener = this.streamEndListeners.get(envelope.sid)
          if (endListener) {
            endListener(envelope.ok, envelope.e)
          } else {
            this.streamEndBuffers.set(envelope.sid, { ok: envelope.ok, err: envelope.e })
          }
        }
      }
    } catch {
      // Invalid JSON
    }
  }

  onStreamItem(sid: number, listener: (item: any) => void): void {
    this.streamListeners.set(sid, listener)
    const buffered = this.streamBuffers.get(sid)
    if (buffered) {
      this.streamBuffers.delete(sid)
      for (const item of buffered) {
        listener(item)
      }
    }
  }

  onStreamEnd(sid: number, listener: (ok: boolean, err?: any) => void): void {
    this.streamEndListeners.set(sid, listener)
    const endBuf = this.streamEndBuffers.get(sid)
    if (endBuf) {
      this.streamEndBuffers.delete(sid)
      listener(endBuf.ok, endBuf.err)
    }
  }

  collectStreamItems(
    sid: number,
    predicate: (items: any[]) => boolean,
    timeoutMs = 5000,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const items: any[] = []
      const timer = setTimeout(() => {
        reject(
          new Error(
            `collectStreamItems timed out after ${timeoutMs}ms, collected ${items.length} items: ${JSON.stringify(items)}`,
          ),
        )
      }, timeoutMs)

      this.onStreamItem(sid, (item) => {
        items.push(item)
        if (predicate(items)) {
          clearTimeout(timer)
          resolve(items)
        }
      })
    })
  }

  cancelStream(sid: number): void {
    const cancelMsg = { k: 'cancel', sid }
    const plaintext = utf8ToBytes(JSON.stringify(cancelMsg))
    const ciphertext = this.sendCipher.encryptWithAd(EMPTY_AAD, plaintext)
    const record = concatBytes(new Uint8Array([RECORD_TYPE.TRANSPORT]), ciphertext)
    this.sendFrame(record)
    this.streamListeners.delete(sid)
    this.streamEndListeners.delete(sid)
    this.streamBuffers.delete(sid)
    this.streamEndBuffers.delete(sid)
  }

  async call<T = unknown>(
    method: string,
    args: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const id = this.nextRequestId++
    const request = {
      k: 'req',
      id,
      m: method,
      p: args,
    }

    const plaintext = utf8ToBytes(JSON.stringify(request))
    const ciphertext = this.sendCipher.encryptWithAd(EMPTY_AAD, plaintext)
    const record = concatBytes(new Uint8Array([RECORD_TYPE.TRANSPORT]), ciphertext)

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`RCP call ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, {
        resolve: resolve as (res: any) => void,
        reject,
        timer,
      })

      this.sendFrame(record)
    })
  }

  /** The testkit's wire app identity is fixed, independent of its display name. */
  async hello(_clientName = 'remora-testkit', clientVersion = '1.0.0'): Promise<ReturnType<typeof HelloResultSchema.parse>> {
    return HelloResultSchema.parse(await this.call('hello', {
      rcp: [RCP_VERSION],
      app: { name: 'remora-testkit', version: clientVersion },
    }))
  }

  async ping(t = Date.now()): Promise<{ t: number; hostTime: number }> {
    return this.call('ping', { t })
  }

  async hostStatus(): Promise<ReturnType<typeof HostStatusResultSchema.parse>> {
    return HostStatusResultSchema.parse(await this.call('host.status'))
  }

  close(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Channel closed'))
    }
    this.pendingRequests.clear()
  }
}

export class FakeDevice {
  readonly relayKeypair: Keypair
  readonly noiseKeypair: Keypair
  readonly deviceId: string
  devicePsk: Uint8Array
  readonly name: string

  private link: RelayLink | null = null
  private channels = new Map<number, FakeDeviceChannel>()
  private handshakeWaiters = new Map<number, {
    resolve: (msg2: Uint8Array) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()
  private pairingResultHandlers = new Map<number, (recordData: Uint8Array) => void>()

  constructor(options: FakeDeviceOptions = {}) {
    if (options.relayKeypair) {
      this.relayKeypair = options.relayKeypair
    } else {
      const priv = randomBytes(32)
      this.relayKeypair = {
        privateKey: priv,
        publicKey: getRelayPublicKey(priv),
      }
    }

    this.noiseKeypair = options.noiseKeypair ?? generateKeypair()
    this.deviceId = deriveEndpointId('d_', this.relayKeypair.publicKey)
    this.devicePsk = options.devicePsk ?? randomBytes(32)
    this.name = options.name ?? `FakeDevice-${this.deviceId.slice(2, 8)}`
  }

  get isConnected(): boolean {
    return this.link?.state === 'ready'
  }

  get state(): RelayLinkState {
    return this.link?.state ?? 'idle'
  }

  async enrollAtRelay(
    relayHttpUrl: string,
    ticket: string,
    platform = 'android',
  ): Promise<{ v: number; id: string; hostId: string }> {
    const url = new URL('/v1/enroll/device', relayHttpUrl)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        ticket,
        relayPub: encodeBase64Url(this.relayKeypair.publicKey),
        name: this.name,
        platform,
      }),
    })

    if (!res.ok) {
      throw new Error(`Device enrollment failed (${res.status}): ${await res.text()}`)
    }
    return (await res.json()) as { v: number; id: string; hostId: string }
  }

  async connectToRelay(relayWsUrl: string, timeoutMs = 10_000): Promise<void> {
    if (this.link) {
      await this.disconnect()
    }

    const url = new URL(relayWsUrl)
    if (url.protocol === 'http:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1/connect'

    this.link = new RelayLink({
      url: url.toString(),
      endpointId: this.deviceId,
      endpointKind: 'device',
      relayPrivateKey: this.relayKeypair.privateKey,
    })

    this.link.on('data', (frame: DataFrame) => {
      this.handleIncomingDataFrame(frame)
    })

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Relay connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.link!.once('ready', () => {
        clearTimeout(timer)
        resolve()
      })

      this.link!.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })

      this.link!.start()
    })
  }

  async openSecureChannel(options: FakeChannelOptions): Promise<FakeDeviceChannel> {
    if (!this.link || this.link.state !== 'ready') {
      throw new Error('FakeDevice must be connected to relay before opening a channel')
    }

    const channelId = options.channelId ?? 1
    const hostRawId = decodeBase32(options.hostId.slice(2))
    const timeoutMs = options.timeoutMs ?? 10_000

    const prologue = utf8ToBytes(
      `remora/1\x00session\x00${options.hostId}\x00${this.deviceId}`,
    )

    const initiator = createInitiatorHandshake({
      staticKey: this.noiseKeypair.privateKey,
      remoteStaticKey: options.hostNoisePublicKey,
      psk: this.devicePsk,
      prologue,
    })

    const msg1Bytes = initiator.writeMessage(new Uint8Array(0))
    const msg1Record = concatBytes(new Uint8Array([RECORD_TYPE.HANDSHAKE_MSG1]), msg1Bytes)

    const waitMsg2 = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiters.delete(channelId)
        reject(new Error(`Handshake msg2 timed out on channel ${channelId} after ${timeoutMs}ms`))
      }, timeoutMs)

      this.handshakeWaiters.set(channelId, {
        resolve,
        reject,
        timer,
      })
    })

    // Send msg1 frame to host
    this.link.sendData(
      { peerKind: PeerKind.HOST, peerId: hostRawId },
      channelId,
      msg1Record,
    )

    const msg2Body = await waitMsg2
    initiator.readMessage(msg2Body)

    const channel = new FakeDeviceChannel(
      channelId,
      options.hostId,
      hostRawId,
      initiator.result.sendCipher,
      initiator.result.recvCipher,
      initiator.result.handshakeHash,
      (payload) => {
        if (!this.link || this.link.state !== 'ready') {
          throw new Error('Cannot send data; relay disconnected')
        }
        this.link.sendData(
          { peerKind: PeerKind.HOST, peerId: hostRawId },
          channelId,
          payload,
        )
      },
    )

    this.channels.set(channelId, channel)
    return channel
  }

  async startPairing(
    qrPayload: string,
    relayHttpUrl?: string,
  ): Promise<{
    sasCode: string
    waitForResult: (timeoutMs?: number) => Promise<{ ok: true; devicePsk: Uint8Array } | { ok: false; reason: string }>
  }> {
    const qrData = parsePairingQr(qrPayload)
    const httpOrigin = relayHttpUrl ?? qrData.relayOrigin
    const pairPsk = derivePairPsk(qrData.pairingSecret, qrData.hostId)

    // Enroll at relay
    await this.enrollAtRelay(httpOrigin, encodeBase64Url(qrData.ticket))

    // Connect to relay if needed
    if (!this.isConnected) {
      const wsUrl = httpOrigin.replace(/^http/, 'ws')
      await this.connectToRelay(wsUrl)
    }

    const channelId = 1
    const hostRawId = decodeBase32(qrData.hostId.slice(2))
    const prologue = utf8ToBytes(`remora/1\x00pair\x00${qrData.hostId}\x00${this.deviceId}`)

    const initiator = createInitiatorHandshake({
      staticKey: this.noiseKeypair.privateKey,
      remoteStaticKey: qrData.hostNoisePub,
      psk: pairPsk,
      prologue,
    })

    const msg1Payload = utf8ToBytes(
      JSON.stringify({
        v: 1,
        purpose: 'pair',
        deviceId: this.deviceId,
        relayPub: encodeBase64Url(this.relayKeypair.publicKey),
        name: this.name,
      }),
    )
    const msg1Bytes = initiator.writeMessage(msg1Payload)
    const msg1Record = concatBytes(new Uint8Array([RECORD_TYPE.HANDSHAKE_MSG1]), msg1Bytes)

    const waitMsg2 = new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handshakeWaiters.delete(channelId)
        reject(new Error(`Pairing handshake msg2 timed out`))
      }, 10_000)
      this.handshakeWaiters.set(channelId, { resolve, reject, timer })
    })

    this.link!.sendData(
      { peerKind: PeerKind.HOST, peerId: hostRawId },
      channelId,
      msg1Record,
    )

    const msg2Body = await waitMsg2
    initiator.readMessage(msg2Body)

    const sasCode = deriveSasCode(initiator.result.handshakeHash)
    const recvCipher = initiator.result.recvCipher

    const waitForResult = (timeoutMs = 10_000) => {
      return new Promise<{ ok: true; devicePsk: Uint8Array } | { ok: false; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pairingResultHandlers.delete(channelId)
          reject(new Error(`Pairing result timed out after ${timeoutMs}ms`))
        }, timeoutMs)

        this.pairingResultHandlers.set(channelId, (recordData: Uint8Array) => {
          clearTimeout(timer)
          this.pairingResultHandlers.delete(channelId)
          try {
            const plaintext = recvCipher.decryptWithAd(new Uint8Array(0), recordData)
            const msg = JSON.parse(new TextDecoder().decode(plaintext))
            if (msg.m === 'pair.complete' && msg.p?.devicePsk) {
              this.devicePsk = decodeBase64Url(msg.p.devicePsk)
              resolve({ ok: true, devicePsk: this.devicePsk })
            } else if (msg.m === 'pair.rejected') {
              resolve({ ok: false, reason: msg.p?.reason ?? 'rejected' })
            } else {
              reject(new Error(`Unexpected pairing message: ${JSON.stringify(msg)}`))
            }
          } catch (err) {
            reject(err)
          }
        })
      })
    }

    return { sasCode, waitForResult }
  }

  private handleIncomingDataFrame(frame: DataFrame): void {
    if (frame.payload.length < 1) return
    const recordType = frame.payload[0]
    const recordData = frame.payload.subarray(1)

    if (recordType === RECORD_TYPE.HANDSHAKE_MSG2) {
      const waiter = this.handshakeWaiters.get(frame.channel)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.handshakeWaiters.delete(frame.channel)
        waiter.resolve(recordData)
      }
    } else if (recordType === RECORD_TYPE.TRANSPORT) {
      const pairingHandler = this.pairingResultHandlers.get(frame.channel)
      if (pairingHandler) {
        pairingHandler(recordData)
        return
      }
      const channel = this.channels.get(frame.channel)
      if (channel) {
        channel.handleTransportPayload(recordData)
      }
    }
  }

  getChannel(channelId: number): FakeDeviceChannel | undefined {
    return this.channels.get(channelId)
  }

  async disconnect(): Promise<void> {
    for (const channel of this.channels.values()) {
      channel.close()
    }
    this.channels.clear()

    for (const waiter of this.handshakeWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Device disconnected'))
    }
    this.handshakeWaiters.clear()
    this.pairingResultHandlers.clear()

    if (this.link) {
      await this.link.stop?.()
      this.link = null
    }
  }
}
