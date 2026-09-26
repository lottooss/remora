/**
 * SC/1 secure channel (Crypto/1 §6): the host side of one Noise IKpsk2
 * responder handshake plus its transport session, keyed by relay channel id.
 *
 * Every RLY/1 data frame payload carries an SC/1 record: `type (1 B) ‖ body`,
 * where the body is a Noise handshake message (`0x01`/`0x02`) or Noise
 * transport ciphertext (`0x03`) of exactly one RCP/1 message.
 *
 * Fail closed: frames whose relay header is not a device source, channel 0,
 * unknown record types, unpaired or revoked devices, a learned initiator
 * static key that differs from the stored DeviceNoiseKey, and any Noise error
 * are dropped without a response and counted as an auth failure where the
 * spec says so (Crypto/1 §6 "session admission").
 */
import { timingSafeEqual } from 'node:crypto'
import {
  concatBytes,
  createResponderHandshake,
  encodeBase32,
  utf8ToBytes,
  type CipherState,
} from '@remora/crypto'
import { PeerKind, encodeDataFrame, type DataFrame } from '@remora/protocol'
import type { DeviceRegistry } from '../devices/index.ts'
import type { HostIdentity } from '../identity/index.ts'
import type { RcpServer } from '../rcp/index.ts'

/** First byte of an SC/1 record inside a relay data frame payload (Crypto/1 §6). */
export const RECORD_TYPE = {
  HANDSHAKE_MSG1: 0x01,
  HANDSHAKE_MSG2: 0x02,
  TRANSPORT: 0x03,
} as const

/** Half-open handshake flood limits (Crypto/1 §6 "handshake flooding"). */
const MAX_HALF_OPEN_PER_DEVICE = 4
const MAX_HALF_OPEN_TOTAL = 32

/** One established channel: the two transport CipherStates from Split(). */
export interface ChannelSession {
  channelId: number
  deviceId: string
  /** 16-byte relay peer id of the device, kept for outbound replies. */
  peerRawId: Uint8Array
  sendCipher: CipherState
  recvCipher: CipherState
  /** Handshake hash h once complete (channel binding). */
  handshakeHash: Uint8Array
  createdAt: number
}

/** Sends one encoded RLY/1 data frame (bytes as produced by {@link encodeDataFrame}). */
export type SendFrameCallback = (frameBytes: Uint8Array) => Promise<void> | void

export interface ChannelManagerOptions {
  /** Host identity: X25519 static key and endpoint id for the prologue. */
  identity: HostIdentity
  /** Paired-device storage domain (real pairing arrives with P2-H1). */
  registry: DeviceRegistry
  /** Receives decrypted RCP plaintext, returns the response plaintext or null. */
  rcpServer: RcpServer
  /** Where encoded outbound frames go (the relay connection in production). */
  sendFrame: SendFrameCallback
  /** Optional pairing service for new device pairings. */
  pairingService?: {
    hasActiveAttempt(): boolean
    handlePairingHandshake(
      deviceId: string,
      channelId: number,
      peerRawId: Uint8Array,
      msg1Bytes: Uint8Array,
    ): Promise<boolean>
  }
}

export class ChannelManager {
  private readonly sessions = new Map<string, ChannelSession>()
  private readonly halfOpenCount = new Map<string, number>()
  private totalHalfOpen = 0
  private authFailures = 0

  constructor(private readonly options: ChannelManagerOptions) {
    options.rcpServer.setTransportSender?.((deviceId, channelId, msg) =>
      this.sendTransport(deviceId, channelId, msg),
    )
  }

  /** Sends an encrypted RCP transport frame to a device over an open channel. */
  async sendTransport(deviceId: string, channelId: number, messageJson: string): Promise<boolean> {
    const session = this.sessions.get(this.sessionKey(deviceId, channelId))
    if (!session) return false

    try {
      const responseCiphertext = session.sendCipher.encryptWithAd(
        new Uint8Array(0),
        utf8ToBytes(messageJson),
      )
      const frameBytes = encodeDataFrame({
        channel: channelId,
        peerKind: PeerKind.DEVICE,
        peerId: session.peerRawId,
        payload: concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), responseCiphertext),
      })
      await this.options.sendFrame(frameBytes)
      return true
    } catch {
      this.closeSession(deviceId, channelId)
      return false
    }
  }

  /** Close all active sessions for a specific device (e.g. upon revocation). */
  closeDeviceChannels(deviceId: string): void {
    for (const [key, session] of this.sessions.entries()) {
      if (session.deviceId === deviceId) {
        this.sessions.delete(key)
      }
    }
  }

  /** Sessions are addressed by device *and* channel: a channel id is single-use. */
  private sessionKey(deviceId: string, channelId: number): string {
    return `${deviceId}:${channelId}`
  }

  /**
   * Device endpoint id from the relay frame's peer id. The relay rewrites the
   * header to the source endpoint before delivery (RLY/1 §6), so this is the
   * id of the sending device.
   */
  private deriveDeviceId(peerRawId: Uint8Array): string {
    return `d_${encodeBase32(peerRawId)}`
  }

  /**
   * Handles one decoded relay data frame. Resolves after the frame is fully
   * processed; rejects only when the outbound relay write itself failed.
   * @param frame - frame as delivered by the relay (peer = the sending device).
   */
  async handleDataFrame(frame: DataFrame): Promise<void> {
    if (frame.peerKind !== PeerKind.DEVICE) return
    // Channel ids are non-zero u32 chosen by the initiator (Crypto/1 §6).
    if (frame.channel === 0) return
    if (frame.payload.length === 0) return

    const recordType = frame.payload[0]
    const recordData = frame.payload.subarray(1)
    const deviceId = this.deriveDeviceId(frame.peerId)

    if (recordType === RECORD_TYPE.HANDSHAKE_MSG1) {
      await this.handleHandshakeMsg1(deviceId, frame.channel, frame.peerId, recordData)
    } else if (recordType === RECORD_TYPE.TRANSPORT) {
      await this.handleTransportMessage(deviceId, frame.channel, frame.peerId, recordData)
    }
    // Every other record (including a msg2, which only devices read) is dropped.
  }

  private async handleHandshakeMsg1(
    deviceId: string,
    channelId: number,
    peerRawId: Uint8Array,
    msg1Bytes: Uint8Array,
  ): Promise<void> {
    const sessionKey = this.sessionKey(deviceId, channelId)
    // A msg1 may never replace an established session on the same channel.
    if (this.sessions.has(sessionKey)) return

    // Session admission (Crypto/1 §6): paired and not revoked, else check pairing attempt.
    const device = this.options.registry.getDeviceById(deviceId)
    if (!device || device.revoked) {
      if (this.options.pairingService?.hasActiveAttempt()) {
        const handled = await this.options.pairingService.handlePairingHandshake(
          deviceId,
          channelId,
          peerRawId,
          msg1Bytes,
        )
        if (handled) return
      }
      this.authFailures += 1
      return
    }

    const deviceHalfOpen = this.halfOpenCount.get(deviceId) ?? 0
    if (deviceHalfOpen >= MAX_HALF_OPEN_PER_DEVICE || this.totalHalfOpen >= MAX_HALF_OPEN_TOTAL) {
      return
    }
    this.halfOpenCount.set(deviceId, deviceHalfOpen + 1)
    this.totalHalfOpen += 1

    try {
      const prologue = utf8ToBytes(
        `remora/1\x00session\x00${this.options.identity.hostId}\x00${deviceId}`,
      )

      const responder = createResponderHandshake({
        staticKey: this.options.identity.noiseKeypair.privateKey,
        psk: device.devicePsk,
        prologue,
      })

      // Reads msg1 and learns the initiator's static key.
      responder.readMessage(msg1Bytes)

      const learnedStatic = responder.remoteStatic
      if (!learnedStatic || !equalBytes(learnedStatic, device.noisePublicKey)) {
        // The static key must equal the stored DeviceNoiseKey for this device.
        this.authFailures += 1
        return
      }

      const msg2Bytes = responder.writeMessage(
        utf8ToBytes(JSON.stringify({ v: 1, time: Date.now() })),
      )

      const frameBytes = encodeDataFrame({
        channel: channelId,
        peerKind: PeerKind.DEVICE,
        peerId: peerRawId,
        payload: concatBytes(Uint8Array.of(RECORD_TYPE.HANDSHAKE_MSG2), msg2Bytes),
      })
      const session: ChannelSession = {
        channelId,
        deviceId,
        peerRawId,
        sendCipher: responder.result.sendCipher,
        recvCipher: responder.result.recvCipher,
        handshakeHash: responder.result.handshakeHash,
        createdAt: Date.now(),
      }
      this.sessions.set(sessionKey, session)

      try {
        await this.options.sendFrame(frameBytes)
        device.lastSeenAt = Date.now()
      } catch (err) {
        this.sessions.delete(sessionKey)
        throw err
      }
    } catch {
      // Noise, framing, and send errors fail closed: no session, no response.
    } finally {
      const remaining = (this.halfOpenCount.get(deviceId) ?? 1) - 1
      if (remaining <= 0) {
        this.halfOpenCount.delete(deviceId)
      } else {
        this.halfOpenCount.set(deviceId, remaining)
      }
      this.totalHalfOpen = Math.max(0, this.totalHalfOpen - 1)
    }
  }

  private async handleTransportMessage(
    deviceId: string,
    channelId: number,
    peerRawId: Uint8Array,
    ciphertext: Uint8Array,
  ): Promise<void> {
    const session = this.sessions.get(this.sessionKey(deviceId, channelId))
    if (!session) return

    let plaintext: Uint8Array
    try {
      plaintext = session.recvCipher.decryptWithAd(new Uint8Array(0), ciphertext)
    } catch {
      // Any decryption failure closes the channel immediately (Crypto/1 §6).
      this.closeSession(deviceId, channelId)
      return
    }

    const rawMessage = new TextDecoder().decode(plaintext)
    const responseJson = await this.options.rcpServer.handleMessage(rawMessage, {
      deviceId,
      channelId,
    })
    if (!responseJson) return

    try {
      const responseCiphertext = session.sendCipher.encryptWithAd(
        new Uint8Array(0),
        utf8ToBytes(responseJson),
      )
      const frameBytes = encodeDataFrame({
        channel: channelId,
        peerKind: PeerKind.DEVICE,
        peerId: peerRawId,
        payload: concatBytes(Uint8Array.of(RECORD_TYPE.TRANSPORT), responseCiphertext),
      })
      await this.options.sendFrame(frameBytes)
    } catch {
      // A failed reply means the channel is no longer usable; reconnect with a new handshake.
      this.closeSession(deviceId, channelId)
    }
  }

  /** Closes one channel and zeroizes its transport keys. */
  closeSession(deviceId: string, channelId: number): void {
    const key = this.sessionKey(deviceId, channelId)
    const session = this.sessions.get(key)
    if (!session) return
    session.sendCipher.zeroize()
    session.recvCipher.zeroize()
    this.sessions.delete(key)
  }

  /** Closes every channel of one device (revocation, unpair, rekey). */
  closeDevice(deviceId: string): void {
    // Deleting the visited entry during iteration is safe for Map iterators.
    for (const [key, session] of this.sessions) {
      if (session.deviceId !== deviceId) continue
      session.sendCipher.zeroize()
      session.recvCipher.zeroize()
      this.sessions.delete(key)
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.sendCipher.zeroize()
      session.recvCipher.zeroize()
    }
    this.sessions.clear()
    this.halfOpenCount.clear()
    this.totalHalfOpen = 0
  }

  hasSession(deviceId: string, channelId: number): boolean {
    return this.sessions.has(this.sessionKey(deviceId, channelId))
  }

  getActiveSessionsCount(): number {
    return this.sessions.size
  }

  /** Admissions refused by session admission: unknown, revoked, or wrong static key. */
  getAuthFailureCount(): number {
    return this.authFailures
  }
}

/** Constant-time byte comparison (Crypto/1 §1: no secret-dependent branches). */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}
