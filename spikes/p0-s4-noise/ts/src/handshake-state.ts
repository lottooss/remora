/**
 * Noise_IKpsk2_25519_ChaChaPoly_SHA256 HandshakeState (Noise rev. 34 §5.3, §7.5 IK, §9 psk).
 *
 * Scope is deliberately minimal — this pattern only, as a spike for SC/1:
 *
 *   IKpsk2:
 *     <- s                 (pre-message: initiator knows the responder static key)
 *     ...
 *     -> e, es, s, ss      (message 1)
 *     <- e, ee, se, psk    (message 2)
 *
 * Ownership: the static secret, injected ephemeral secret, and psk passed to
 * the constructor belong to the state and are zeroized when the handshake splits.
 */
import { NoiseError } from './errors.ts'
import { DHLEN, MAX_NOISE_MESSAGE, dh, generateKeypair, keypairFromSecret, type Keypair } from './primitives.ts'
import { SymmetricState } from './symmetric-state.ts'

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk'

/** IK pattern (§7.5) + psk2 modifier: the "psk" token ends message 2 (§9.4). */
const MESSAGE_PATTERNS: readonly (readonly Token[])[] = [
  ['e', 'es', 's', 'ss'],
  ['e', 'ee', 'se', 'psk'],
]

/** The canonical protocol name; > HASHLEN so InitializeSymmetric hashes it. */
export const PROTOCOL_NAME = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256'

const EMPTY = new Uint8Array(0)

export interface HandshakeOptions {
  initiator: boolean
  prologue: Uint8Array
  staticKeypair: Keypair
  /** Initiator must pin the responder static key (the IK pre-message). */
  remoteStatic?: Uint8Array
  /** 32-byte PSK (Noise §14: 256 bits of entropy). Consumed by the "psk" token. */
  psk?: Uint8Array
  /** Test-only: fixed local ephemeral secret, so vectors are reproducible. */
  ephemeralSecret?: Uint8Array
}

export interface HandshakeResult {
  /** Transport cipher for messages this side sends. */
  send: CipherStateType
  /** Transport cipher for messages this side receives. */
  recv: CipherStateType
  handshakeHash: Uint8Array
  /** Peer static public key (learned by the reader of message 1). */
  remoteStatic: Uint8Array
}

import type { CipherState as CipherStateType } from './cipher-state.ts'

export class HandshakeState {
  private readonly initiator: boolean
  private readonly symmetric: SymmetricState
  private readonly s: Keypair
  private psk: Uint8Array | undefined
  private ephemeralSecret: Uint8Array | undefined
  private e: Keypair | undefined
  private rs: Uint8Array | undefined
  private re: Uint8Array | undefined
  private patternIndex = 0
  private handshakeResult: HandshakeResult | undefined

  constructor(options: HandshakeOptions) {
    this.initiator = options.initiator
    this.symmetric = new SymmetricState(PROTOCOL_NAME)
    this.s = options.staticKeypair
    if (options.psk !== undefined && options.psk.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'PSK must be 32 bytes')
    }
    this.psk = options.psk
    this.ephemeralSecret = options.ephemeralSecret

    this.symmetric.mixHash(options.prologue)

    if (options.initiator) {
      if (options.remoteStatic === undefined) throw new NoiseError('missing_key', 'IK initiator must pin rs')
      if (options.remoteStatic.length !== DHLEN) throw new NoiseError('invalid_key_length', 'rs must be 32 bytes')
      this.rs = options.remoteStatic
    }
    // IK pre-message "<- s": both sides hash the responder public static key.
    this.symmetric.mixHash(this.initiator ? this.rs ?? EMPTY : options.staticKeypair.publicKey)
  }

  get isComplete(): boolean {
    return this.handshakeResult !== undefined
  }

  get result(): HandshakeResult {
    if (this.handshakeResult === undefined) throw new NoiseError('handshake_incomplete', 'handshake not finished')
    return this.handshakeResult
  }

  /** Peer static key once message 1 has been read (session admission gate). */
  get remoteStatic(): Uint8Array | undefined {
    return this.rs
  }

  /** Current handshake hash h (channel binding once complete). */
  get handshakeHash(): Uint8Array {
    return this.symmetric.getHandshakeHash()
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    this.assertActive()
    this.assertTurn(true)
    const parts: Uint8Array[] = []
    for (const token of MESSAGE_PATTERNS[this.patternIndex] as readonly Token[]) {
      const part = this.processWriteToken(token)
      if (part.length > 0) parts.push(part)
    }
    parts.push(this.symmetric.encryptAndHash(payload))
    const out = concat(parts)
    if (out.length > MAX_NOISE_MESSAGE) {
      throw new NoiseError('message_too_large', `handshake message ${out.length} bytes exceeds 65535`)
    }
    this.patternIndex += 1
    if (this.patternIndex === MESSAGE_PATTERNS.length) this.finish()
    return out
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.assertActive()
    this.assertTurn(false)
    let offset = 0
    for (const token of MESSAGE_PATTERNS[this.patternIndex] as readonly Token[]) {
      offset = this.processReadToken(token, message, offset)
    }
    const payload = this.symmetric.decryptAndHash(message.subarray(offset))
    this.patternIndex += 1
    if (this.patternIndex === MESSAGE_PATTERNS.length) this.finish()
    return payload
  }

  private processWriteToken(token: Token): Uint8Array {
    switch (token) {
      case 'e': {
        const secret = this.ephemeralSecret
        this.ephemeralSecret = undefined
        this.e = secret === undefined ? generateKeypair() : keypairFromSecret(secret)
        this.symmetric.mixHash(this.e.publicKey)
        // PSK handshake (§9.2): every "e" in a message pattern is followed by MixKey(e.public_key).
        this.symmetric.mixKey(this.e.publicKey)
        return this.e.publicKey
      }
      case 's':
        return this.symmetric.encryptAndHash(this.s.publicKey)
      case 'ee':
        this.symmetric.mixKey(dh(this.requireEphemeral().secretKey, this.requireRe()))
        return EMPTY
      case 'es':
        this.symmetric.mixKey(
          this.initiator
            ? dh(this.requireEphemeral().secretKey, this.requireRs())
            : dh(this.s.secretKey, this.requireRe()),
        )
        return EMPTY
      case 'se':
        this.symmetric.mixKey(
          this.initiator
            ? dh(this.s.secretKey, this.requireRe())
            : dh(this.requireEphemeral().secretKey, this.requireRs()),
        )
        return EMPTY
      case 'ss':
        this.symmetric.mixKey(dh(this.s.secretKey, this.requireRs()))
        return EMPTY
      case 'psk': {
        const psk = this.takePsk()
        this.symmetric.mixKeyAndHash(psk)
        return EMPTY
      }
    }
  }

  private processReadToken(token: Token, message: Uint8Array, offset: number): number {
    switch (token) {
      case 'e': {
        const re = slice(message, offset, DHLEN)
        this.re = re
        this.symmetric.mixHash(re)
        // PSK handshake (§9.2).
        this.symmetric.mixKey(re)
        return offset + DHLEN
      }
      case 's': {
        const size = this.symmetric.cipherState.hasKey() ? DHLEN + 16 : DHLEN
        const rs = this.symmetric.decryptAndHash(slice(message, offset, size))
        if (rs.length !== DHLEN) throw new NoiseError('invalid_message', 'bad static key length')
        if (this.rs !== undefined) throw new NoiseError('invalid_message', 'static key already set')
        this.rs = rs
        return offset + size
      }
      case 'ee':
        this.symmetric.mixKey(dh(this.requireEphemeral().secretKey, this.requireRe()))
        return offset
      case 'es':
        this.symmetric.mixKey(
          this.initiator
            ? dh(this.requireEphemeral().secretKey, this.requireRs())
            : dh(this.s.secretKey, this.requireRe()),
        )
        return offset
      case 'se':
        this.symmetric.mixKey(
          this.initiator
            ? dh(this.s.secretKey, this.requireRe())
            : dh(this.requireEphemeral().secretKey, this.requireRs()),
        )
        return offset
      case 'ss':
        this.symmetric.mixKey(dh(this.s.secretKey, this.requireRs()))
        return offset
      case 'psk': {
        const psk = this.takePsk()
        this.symmetric.mixKeyAndHash(psk)
        return offset
      }
    }
  }

  private takePsk(): Uint8Array {
    const psk = this.psk
    if (psk === undefined) throw new NoiseError('psk_missing', 'pattern requires a psk')
    this.psk = undefined
    return psk
  }

  private finish(): void {
    const [c1, c2] = this.symmetric.split()
    const handshakeHash = this.symmetric.getHandshakeHash()
    const remoteStatic = this.rs
    if (remoteStatic === undefined) throw new NoiseError('missing_key', 'peer static key never learned')
    this.handshakeResult = this.initiator
      ? { send: c1, recv: c2, handshakeHash, remoteStatic }
      : { send: c2, recv: c1, handshakeHash, remoteStatic }
    // Constraint: zeroize ephemeral (and now unused static) secrets after split().
    this.e?.secretKey.fill(0)
    this.s.secretKey.fill(0)
    this.psk = undefined
    this.ephemeralSecret = undefined
  }

  private assertActive(): void {
    if (this.patternIndex >= MESSAGE_PATTERNS.length) throw new NoiseError('handshake_exhausted', 'handshake already finished')
  }

  private assertTurn(writing: boolean): void {
    const initiatorWritesThisPattern = this.patternIndex % 2 === 0
    const callerIsInitiatorWriter = writing ? this.initiator : !this.initiator
    if (initiatorWritesThisPattern !== callerIsInitiatorWriter) {
      throw new NoiseError('invalid_message', 'out-of-turn handshake call')
    }
  }

  private requireEphemeral(): Keypair {
    if (this.e === undefined) throw new NoiseError('invalid_message', 'ephemeral key not available')
    return this.e
  }

  private requireRs(): Uint8Array {
    if (this.rs === undefined) throw new NoiseError('invalid_message', 'remote static key not available')
    return this.rs
  }

  private requireRe(): Uint8Array {
    if (this.re === undefined) throw new NoiseError('invalid_message', 'remote ephemeral key not available')
    return this.re
  }
}

function slice(message: Uint8Array, offset: number, size: number): Uint8Array {
  if (offset + size > message.length) throw new NoiseError('invalid_message', 'handshake message truncated')
  return message.slice(offset, offset + size)
}

function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}
