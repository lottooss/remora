import {
  buildPairingQr,
  deriveEndpointId,
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
import { z } from 'zod'
import type { DeviceRegistry } from '../devices/index.ts'
import type { HostIdentity } from '../identity/index.ts'
import { normalizeApprovalPublicKey } from '../identity/approval-key.ts'

const PairingHelloSchema = z.object({
  v: z.literal(1),
  purpose: z.literal('pair'),
  deviceId: z.string().regex(/^d_[a-z2-7]{26}$/),
  relayPub: z.string().max(64),
  name: z.string().min(1).max(64).regex(/^[^\x00-\x1f\x7f]*$/),
  platform: z.literal('android'),
  approvalPub: z.string().max(256),
  app: z.object({ version: z.string().min(1).max(64) }),
})

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
  registered?: boolean
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
  private starting = false
  private handshakePending = false
  private confirming = false
  private disposed = false

  constructor(private readonly options: PairingServiceOptions) {}

  getActiveAttempt(): PairingAttempt | null {
    if (!this.activeAttempt) return null
    if (Date.now() >= this.activeAttempt.expiresAt) {
      void this.rejectPairing('timeout')
      return null
    }
    return this.activeAttempt
  }

  hasActiveAttempt(): boolean {
    return this.getActiveAttempt() !== null
  }

  async beginPairing(): Promise<PairingAttempt> {
    if (this.disposed || this.starting || this.confirming) throw new Error('pairing is unavailable')
    const requestTicket = this.options.requestEnrollmentTicket
    if (!requestTicket) throw new Error('relay enrollment is required for pairing')
    this.starting = true
    try {
    await this.rejectPairing('rejected')
    const ticket = await requestTicket()
    if (this.disposed || ticket.length !== 32) {
      ticket.fill(0)
      throw new Error('relay enrollment ticket is unavailable')
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
    } finally {
      this.starting = false
    }
  }

  async handlePairingHandshake(
    deviceId: string,
    channelId: number,
    peerRawId: Uint8Array,
    msg1Bytes: Uint8Array,
  ): Promise<boolean> {
    const attempt = this.getActiveAttempt()
    if (!attempt || this.handshakePending || attempt.state !== 'awaiting_handshake' ||
        channelId === 0 || peerRawId.length !== 16 ||
        deviceId !== `d_${encodeBase32(peerRawId)}` || msg1Bytes.length > 4096) {
      return false
    }
    this.handshakePending = true
    const pairPsk = derivePairPsk(attempt.pairingSecret, this.options.identity.hostId)
    try {
      const prologue = utf8ToBytes(
        `remora/1\x00pair\x00${this.options.identity.hostId}\x00${deviceId}`,
      )

      const responder = createResponderHandshake({
        staticKey: this.options.identity.noiseKeypair.privateKey,
        psk: pairPsk,
        prologue,
      })

      // IKpsk2 msg1 authenticates the Noise static key, not PSK possession.
      // The PSK is mixed into msg2; the owner then compares the bound SAS.
      const decryptedMsg1 = responder.readMessage(msg1Bytes)
      const learnedStatic = responder.remoteStatic
      if (!learnedStatic) return false

      const parsedMsg1 = PairingHelloSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decryptedMsg1)))
      if (parsedMsg1.deviceId !== deviceId) return false
      const pub = decodeBase64Url(parsedMsg1.relayPub)
      if (pub.length !== 32 || deriveEndpointId('d_', pub) !== deviceId) return false
      const approvalPub = normalizeApprovalPublicKey(decodeBase64Url(parsedMsg1.approvalPub))

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

      // SAS from the completed Noise transcript hash (Crypto/1 §5.3): binds
      // the confirmation to this exact handshake, not to the static keys.
      const sasCode = deriveSasCode(responder.result.handshakeHash)

      attempt.deviceId = deviceId
      attempt.deviceName = parsedMsg1.name
      attempt.peerRawId = peerRawId.slice()
      attempt.channelId = channelId
      attempt.learnedStatic = learnedStatic
      attempt.approvalPub = approvalPub
      attempt.sasCode = sasCode
      attempt.sasExpiresAt = Date.now() + 120_000 // 2-minute SAS window
      attempt.sendCipher = responder.result.sendCipher
      attempt.recvCipher = responder.result.recvCipher
      attempt.state = 'awaiting_confirmation'

      await this.options.sendFrame(frameBytes)
      if (this.activeAttempt !== attempt || this.disposed) return false

      this.options.onStateChange?.(attempt)

      // SAS timeout in 2 minutes
      this.sasTimeoutHandle = setTimeout(() => {
        if (this.activeAttempt === attempt && attempt.state === 'awaiting_confirmation') {
          void this.rejectPairing('timeout')
        }
      }, 120_000)

      return true
    } catch {
      if (this.activeAttempt === attempt && attempt.state !== 'awaiting_handshake') await this.rejectPairing('rejected')
      return false
    } finally {
      pairPsk.fill(0)
      this.handshakePending = false
    }
  }

  async confirmPairing(sasCode: string): Promise<boolean> {
    const attempt = this.getActiveAttempt()
    if (!attempt || this.confirming || attempt.state !== 'awaiting_confirmation') {
      return false
    }

    if (attempt.sasCode !== sasCode || !attempt.sasExpiresAt || Date.now() >= attempt.sasExpiresAt ||
        !attempt.deviceId || !attempt.learnedStatic || !attempt.approvalPub ||
        !attempt.sendCipher || !attempt.channelId || !attempt.peerRawId) {
      return false
    }

    this.cancelTimeouts()
    this.confirming = true

    const devicePsk = randomBytes(32)
    const pushKey = randomBytes(32)

    try {
    // The durable write must finish before credentials are sent to the phone.
    this.options.registry.addDevice({
      deviceId: attempt.deviceId,
      name: attempt.deviceName ?? 'Device',
      noisePublicKey: attempt.learnedStatic.slice(),
      devicePsk,
      pushKey,
      approvalPublicKey: attempt.approvalPub,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      revoked: false,
    })
    attempt.registered = true
    await this.options.registry.flush?.()
    if (this.activeAttempt !== attempt || this.disposed) throw new Error('pairing cancelled')

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

      await this.options.sendFrame(frameBytes)
    }

    if (this.activeAttempt !== attempt || this.disposed) throw new Error('pairing cancelled')
    attempt.state = 'completed'
    this.options.onStateChange?.(attempt)
    this.activeAttempt = null
    this.wipeAttempt(attempt)
    return true
    } catch {
      this.options.registry.revokeDevice(attempt.deviceId)
      if (this.activeAttempt === attempt) await this.rejectPairing('rejected')
      await this.options.registry.flush?.().catch(() => {})
      devicePsk.fill(0)
      pushKey.fill(0)
      return false
    } finally {
      this.confirming = false
    }
  }

  async rejectPairing(reason: 'rejected' | 'timeout'): Promise<void> {
    const attempt = this.activeAttempt
    this.cancelTimeouts()
    this.activeAttempt = null

    if (!attempt) return
    if (attempt.registered && attempt.deviceId) this.options.registry.revokeDevice(attempt.deviceId)

    // If channel exists, send pair.rejected event
    if (attempt.sendCipher && attempt.channelId && attempt.peerRawId) {
      const pairRejectedEvt = JSON.stringify({
        k: 'evt',
        e: 'pair.rejected',
        d: { reason },
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
    this.wipeAttempt(attempt)
    this.options.onStateChange?.(null)
  }

  /** Stop pairing timers and erase short-lived secrets when the plugin unloads. */
  dispose(): void {
    this.disposed = true
    this.cancelTimeouts()
    const attempt = this.activeAttempt
    this.activeAttempt = null
    if (attempt) {
      if (attempt.registered && attempt.deviceId) this.options.registry.revokeDevice(attempt.deviceId)
      this.wipeAttempt(attempt)
    }
  }

  private wipeAttempt(attempt: PairingAttempt): void {
    attempt.pairingSecret.fill(0)
    attempt.ticket.fill(0)
    attempt.qrPayload = ''
    attempt.sasCode = undefined
    attempt.sendCipher?.zeroize()
    attempt.recvCipher?.zeroize()
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
