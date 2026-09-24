import {
  buildPairingQr,
  derivePairPsk,
  deriveSasCode,
  encodeBase32,
  encodeBase64Url,
  decodeBase64Url,
  createResponderHandshake,
  randomBytes,
  utf8ToBytes,
  type CipherState,
} from '@remora/crypto'
import { PeerKind, encodeDataFrame } from '@remora/protocol'
import type { DeviceRegistry } from '../devices/index.ts'
import type { HostIdentity } from '../identity/index.ts'

export interface PairingAttempt {
  ticket: Uint8Array
  pairingSecret: Uint8Array
  qrPayload: string
  expiresAt: number
  state: 'awaiting_handshake' | 'awaiting_confirmation' | 'completed' | 'rejected'
  deviceId?: string | undefined
  deviceName?: string | undefined
  peerRawId?: Uint8Array | undefined
  channelId?: number | undefined
  learnedStatic?: Uint8Array | undefined
  approvalPub?: Uint8Array | undefined
  sasCode?: string | undefined
  sasExpiresAt?: number | undefined
  sendCipher?: CipherState | undefined
  recvCipher?: CipherState | undefined
}

export interface PairingServiceOptions {
  identity: HostIdentity
  hostName: string
  relayOrigin: string
  registry: DeviceRegistry
  sendFrame: (frameBytes: Uint8Array) => Promise<void> | void
  requestEnrollmentTicket?: () => Promise<Uint8Array>
  revokeEndpointOnRelay?: (endpointId: string) => Promise<void>
  onStateChange?: (attempt: PairingAttempt | null) => void
}

export class PairingService {
  private activeAttempt: PairingAttempt | null = null
  private sasTimeoutHandle: NodeJS.Timeout | null = null
  private ticketTimeoutHandle: NodeJS.Timeout | null = null

  constructor(private readonly options: PairingServiceOptions) {}

  getActiveAttempt(): PairingAttempt | null {
    if (!this.activeAttempt) return null
    if (Date.now() > this.activeAttempt.expiresAt) {
      this.activeAttempt = null
      return null
    }
    return this.activeAttempt
  }

  hasActiveAttempt(): boolean {
    return this.getActiveAttempt() !== null
  }

  async beginPairing(): Promise<PairingAttempt> {
    this.cancelTimeouts()

    let ticket: Uint8Array
    if (this.options.requestEnrollmentTicket) {
      ticket = await this.options.requestEnrollmentTicket()
    } else {
      ticket = randomBytes(32)
    }

    const pairingSecret = randomBytes(32)
    const expirySeconds = Math.floor(Date.now() / 1000) + 600 // 10 minutes
    const expiresAt = expirySeconds * 1000

    const qrPayload = buildPairingQr({
      relayOrigin: this.options.relayOrigin,
      hostId: this.options.identity.hostId,
      hostNoisePub: this.options.identity.noiseKeypair.publicKey,
      ticket,
      pairingSecret,
      hostName: this.options.hostName,
      expiry: expirySeconds,
    })

    const attempt: PairingAttempt = {
      ticket,
      pairingSecret,
      qrPayload,
      expiresAt,
      state: 'awaiting_handshake',
    }

    this.activeAttempt = attempt
    this.options.onStateChange?.(attempt)

    this.ticketTimeoutHandle = setTimeout(() => {
      if (this.activeAttempt === attempt && attempt.state === 'awaiting_handshake') {
        void this.rejectPairing('timeout')
      }
    }, 600_000)

    return attempt
  }

  async handlePairingHandshake(
    deviceId: string,
    channelId: number,
    peerRawId: Uint8Array,
    msg1Bytes: Uint8Array,
  ): Promise<boolean> {
    const attempt = this.getActiveAttempt()
    if (!attempt || attempt.state !== 'awaiting_handshake') {
      return false
    }

    try {
      const ticketId = `t_${encodeBase32(attempt.ticket.subarray(0, 16))}`
      const pairPsk = derivePairPsk(attempt.pairingSecret, ticketId)
      const prologue = utf8ToBytes(
        `remora/1\x00pair\x00${this.options.identity.hostId}\x00${deviceId}`,
      )

      const responder = createResponderHandshake({
        staticKey: this.options.identity.noiseKeypair.privateKey,
        psk: pairPsk,
        prologue,
      })

      // Read msg1 (decrypts payload with pairPsk)
      const decryptedMsg1 = responder.readMessage(msg1Bytes)
      const learnedStatic = responder.remoteStatic
      if (!learnedStatic) return false

      const msg1Text = new TextDecoder().decode(decryptedMsg1)
      let parsedMsg1: {
        v?: number
        purpose?: string
        deviceId?: string
        relayPub?: string
        name?: string
        approvalPub?: string
      }
      try {
        parsedMsg1 = JSON.parse(msg1Text)
      } catch {
        return false
      }

      if (parsedMsg1.v !== 1 || parsedMsg1.purpose !== 'pair') return false
      if (parsedMsg1.deviceId !== deviceId) return false
      if (parsedMsg1.relayPub) {
        const derived = `d_${encodeBase32(decodeBase64Url(parsedMsg1.relayPub).subarray(0, 16))}`
        if (derived !== deviceId) return false
      }

      // Write msg2
      const msg2Payload = utf8ToBytes(
        JSON.stringify({
          v: 1,
          hostId: this.options.identity.hostId,
          hostName: this.options.hostName,
          versions: { remora: '0.1.0', dsh: '0.1.5-rc.3', rcp: [1] },
        }),
      )
      const msg2Bytes = responder.writeMessage(msg2Payload)

      const frameBytes = encodeDataFrame({
        channel: channelId,
        peerKind: PeerKind.DEVICE,
        peerId: peerRawId,
        payload: new Uint8Array([0x02, ...msg2Bytes]),
      })

      await this.options.sendFrame(frameBytes)

      // Compute SAS code (Crypto/1 §5.6)
      const sasCode = deriveSasCode(
        this.options.identity.noiseKeypair.publicKey,
        learnedStatic,
        pairPsk,
      )

      attempt.deviceId = deviceId
      attempt.deviceName = parsedMsg1.name ?? 'Device'
      attempt.peerRawId = peerRawId
      attempt.channelId = channelId
      attempt.learnedStatic = learnedStatic
      attempt.approvalPub = parsedMsg1.approvalPub ? decodeBase64Url(parsedMsg1.approvalPub) : undefined
      attempt.sasCode = sasCode
      attempt.sasExpiresAt = Date.now() + 120_000 // 2-minute SAS window
      attempt.sendCipher = responder.result.sendCipher
      attempt.recvCipher = responder.result.recvCipher
      attempt.state = 'awaiting_confirmation'

      this.options.onStateChange?.(attempt)

      // SAS timeout in 2 minutes
      this.sasTimeoutHandle = setTimeout(() => {
        if (this.activeAttempt === attempt && attempt.state === 'awaiting_confirmation') {
          void this.rejectPairing('timeout')
        }
      }, 120_000)

      return true
    } catch {
      return false
    }
  }

  async confirmPairing(sasCode: string): Promise<boolean> {
    const attempt = this.getActiveAttempt()
    if (!attempt || attempt.state !== 'awaiting_confirmation') {
      return false
    }

    if (attempt.sasCode !== sasCode || (attempt.sasExpiresAt && Date.now() > attempt.sasExpiresAt)) {
      return false
    }

    this.cancelTimeouts()

    const devicePsk = randomBytes(32)
    const pushKey = randomBytes(32)

    // Store in registry before ack (persistence-before-ack)
    this.options.registry.addDevice({
      deviceId: attempt.deviceId!,
      name: attempt.deviceName ?? 'Device',
      noisePublicKey: attempt.learnedStatic!,
      devicePsk,
      pushKey,
      approvalPublicKey: attempt.approvalPub,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })

    // Send pair.complete RCP request
    if (attempt.sendCipher && attempt.channelId && attempt.peerRawId) {
      const pairCompleteReq = JSON.stringify({
        k: 'req',
        id: 1,
        m: 'pair.complete',
        p: {
          devicePsk: encodeBase64Url(devicePsk),
          pushKey: encodeBase64Url(pushKey),
          host: {
            id: this.options.identity.hostId,
            name: this.options.hostName,
            os: process.platform,
            versions: { remora: '0.1.0', rcp: [1] },
          },
        },
      })

      const plaintext = utf8ToBytes(pairCompleteReq)
      const ciphertext = attempt.sendCipher.encryptWithAd(new Uint8Array(0), plaintext)
      const frameBytes = encodeDataFrame({
        channel: attempt.channelId,
        peerKind: PeerKind.DEVICE,
        peerId: attempt.peerRawId,
        payload: new Uint8Array([0x03, ...ciphertext]),
      })

      try {
        await this.options.sendFrame(frameBytes)
      } catch {
        // frame send failure
      }
    }

    attempt.state = 'completed'
    this.options.onStateChange?.(attempt)
    this.activeAttempt = null
    return true
  }

  async rejectPairing(reason: 'rejected' | 'timeout'): Promise<void> {
    const attempt = this.activeAttempt
    this.cancelTimeouts()
    this.activeAttempt = null

    if (!attempt) return

    // If channel exists, send pair.rejected event
    if (attempt.sendCipher && attempt.channelId && attempt.peerRawId) {
      const pairRejectedEvt = JSON.stringify({
        k: 'evt',
        m: 'pair.rejected',
        p: { reason },
      })
      try {
        const ciphertext = attempt.sendCipher.encryptWithAd(new Uint8Array(0), utf8ToBytes(pairRejectedEvt))
        const frameBytes = encodeDataFrame({
          channel: attempt.channelId,
          peerKind: PeerKind.DEVICE,
          peerId: attempt.peerRawId,
          payload: new Uint8Array([0x03, ...ciphertext]),
        })
        await this.options.sendFrame(frameBytes)
      } catch {
        // best effort
      }
    }

    if (attempt.deviceId && this.options.revokeEndpointOnRelay) {
      try {
        await this.options.revokeEndpointOnRelay(attempt.deviceId)
      } catch {
        // best effort
      }
    }

    attempt.state = 'rejected'
    this.options.onStateChange?.(null)
  }

  private cancelTimeouts(): void {
    if (this.sasTimeoutHandle) {
      clearTimeout(this.sasTimeoutHandle)
      this.sasTimeoutHandle = null
    }
    if (this.ticketTimeoutHandle) {
      clearTimeout(this.ticketTimeoutHandle)
      this.ticketTimeoutHandle = null
    }
  }
}
