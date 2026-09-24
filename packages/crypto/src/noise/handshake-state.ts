/**
 * Noise_IKpsk2_25519_ChaChaPoly_SHA256 HandshakeState (Noise rev. 34 §5.3, §7.5 IK, §9 psk).
 *
 * Scope is this pattern only, as used by SC/1 (Crypto/1 §6):
 *
 *   IKpsk2:
 *     <- s                 (pre-message: initiator knows the responder static key)
 *     ...
 *     -> e, es, s, ss      (message 1)
 *     <- e, ee, se, psk    (message 2)
 *
 * Ownership: the handshake takes ownership of the ephemeral secret (generated or
 * injected) and zeroizes it after Split(). The static private key and PSK are
 * borrowed from the caller (long-lived, reused across handshakes) and are never
 * zeroized here; the caller zeroizes them when their lifetime ends. Derived DH
 * outputs, chaining keys, and handshake cipher keys are zeroized after use.
 */
import { concatBytes } from '@noble/hashes/utils.js'
import type { CipherState } from './cipher-state.ts'
import { NoiseError } from './errors.ts'
import { SymmetricState } from './symmetric-state.ts'
import {
  DHLEN,
  MAX_NOISE_MESSAGE,
  TAGLEN,
  dh,
  generateKeypair,
  keypairFromPrivate,
  type Keypair,
} from './primitives.ts'

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
  /** Local static private key (32 B); borrowed, never zeroized by the handshake. */
  staticKey: Uint8Array
  /** 32-byte PSK (Noise §14: 256 bits of entropy); borrowed, never zeroized here. */
  psk: Uint8Array
  prologue: Uint8Array
  /** Initiator must pin the responder static key (the IK pre-message). */
  remoteStaticKey?: Uint8Array | undefined
  /** Test-only: fixed local ephemeral secret, so vectors are reproducible. Owned and zeroized. */
  ephemeralSecret?: Uint8Array | undefined
}

export interface InitiatorHandshakeOptions {
  staticKey: Uint8Array
  remoteStaticKey: Uint8Array
  psk: Uint8Array
  prologue: Uint8Array
  ephemeralSecret?: Uint8Array
}

export interface ResponderHandshakeOptions {
  staticKey: Uint8Array
  psk: Uint8Array
  prologue: Uint8Array
  ephemeralSecret?: Uint8Array
}

export interface HandshakeResult {
  /** Transport cipher for messages this side sends. */
  sendCipher: CipherState
  /** Transport cipher for messages this side receives. */
  recvCipher: CipherState
  handshakeHash: Uint8Array
  /** Peer static public key (learned by the reader of message 1). */
  remoteStatic: Uint8Array
}

export class HandshakeState {
  private readonly initiator: boolean
  private readonly symmetric: SymmetricState
  private readonly staticKeypair: Keypair
  private psk: Uint8Array | undefined
  private ephemeralSecret: Uint8Array | undefined
  private e: Keypair | undefined
  private rs: Uint8Array | undefined
  private re: Uint8Array | undefined
  private patternIndex = 0
  private handshakeResult: HandshakeResult | undefined

  constructor(options: HandshakeOptions) {
    if (options.staticKey.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'static private key must be 32 bytes')
    }
    if (options.psk.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'PSK must be 32 bytes')
    }
    if (options.ephemeralSecret !== undefined && options.ephemeralSecret.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'ephemeral secret must be 32 bytes')
    }

    this.initiator = options.initiator
    this.staticKeypair = keypairFromPrivate(options.staticKey)
    this.psk = options.psk
    this.ephemeralSecret = options.ephemeralSecret
    this.symmetric = new SymmetricState(PROTOCOL_NAME)

    if (options.initiator) {
      const remoteStaticKey = options.remoteStaticKey
      if (remoteStaticKey === undefined) {
        throw new NoiseError('missing_key', 'IK initiator must pin the responder static key')
      }
      if (remoteStaticKey.length !== DHLEN) {
        throw new NoiseError('invalid_key_length', 'remote static key must be 32 bytes')
      }
      this.rs = remoteStaticKey.slice()
    }

    this.symmetric.mixHash(options.prologue)
    // IK pre-message "<- s": both sides hash the responder public key.
    this.symmetric.mixHash(this.initiator ? this.rs ?? EMPTY : this.staticKeypair.publicKey)
  }

  get isComplete(): boolean {
    return this.handshakeResult !== undefined
  }

  get result(): HandshakeResult {
    if (this.handshakeResult === undefined) {
      throw new NoiseError('handshake_incomplete', 'handshake not finished')
    }
    return this.handshakeResult
  }

  /** Peer static key: pinned at construction for the initiator, learned from message 1 by the responder (session admission gate). */
  get remoteStatic(): Uint8Array | undefined {
    return this.rs
  }

  /** Current handshake hash h (channel binding once complete; SAS input after pairing). */
  get handshakeHash(): Uint8Array {
    return this.symmetric.getHandshakeHash()
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    this.assertActive()
    this.assertTurn(true)
    const parts: Uint8Array[] = []
    for (const token of this.patternAt()) {
      const part = this.processWriteToken(token)
      if (part.length > 0) parts.push(part)
    }
    parts.push(this.symmetric.encryptAndHash(payload))
    const out = concatBytes(...parts)
    if (out.length > MAX_NOISE_MESSAGE) {
      throw new NoiseError('message_too_large', `handshake message ${out.length} exceeds ${MAX_NOISE_MESSAGE}`)
    }
    this.patternIndex += 1
    if (this.patternIndex === MESSAGE_PATTERNS.length) this.finish()
    return out
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.assertActive()
    this.assertTurn(false)
    if (message.length > MAX_NOISE_MESSAGE) {
      throw new NoiseError('message_too_large', `handshake message ${message.length} exceeds ${MAX_NOISE_MESSAGE}`)
    }
    let offset = 0
    for (const token of this.patternAt()) {
      offset = this.processReadToken(token, message, offset)
    }
    const payload = this.symmetric.decryptAndHash(message.slice(offset))
    this.patternIndex += 1
    if (this.patternIndex === MESSAGE_PATTERNS.length) this.finish()
    return payload
  }

  private processWriteToken(token: Token): Uint8Array {
    switch (token) {
      case 'e': {
        if (this.e !== undefined) throw new NoiseError('invalid_message', 'ephemeral key already set')
        const secret = this.ephemeralSecret
        this.ephemeralSecret = undefined
        this.e = secret === undefined ? generateKeypair() : keypairFromPrivate(secret)
        this.symmetric.mixHash(this.e.publicKey)
        // PSK handshake (§9.2): every "e" in a message pattern is followed by MixKey(e.public_key).
        this.symmetric.mixKey(this.e.publicKey)
        return this.e.publicKey
      }
      case 's':
        return this.symmetric.encryptAndHash(this.staticKeypair.publicKey)
      case 'ee':
        this.mixFromDh(this.requireEphemeral().privateKey, this.requireRe())
        return EMPTY
      case 'es':
        if (this.initiator) {
          this.mixFromDh(this.requireEphemeral().privateKey, this.requireRs())
        } else {
          this.mixFromDh(this.staticKeypair.privateKey, this.requireRe())
        }
        return EMPTY
      case 'se':
        if (this.initiator) {
          this.mixFromDh(this.staticKeypair.privateKey, this.requireRe())
        } else {
          this.mixFromDh(this.requireEphemeral().privateKey, this.requireRs())
        }
        return EMPTY
      case 'ss':
        this.mixFromDh(this.staticKeypair.privateKey, this.requireRs())
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
        if (this.re !== undefined) throw new NoiseError('invalid_message', 'remote ephemeral already set')
        const re = readSlice(message, offset, DHLEN)
        this.re = re
        this.symmetric.mixHash(re)
        // PSK handshake (§9.2).
        this.symmetric.mixKey(re)
        return offset + DHLEN
      }
      case 's': {
        const size = this.symmetric.cipherState.hasKey() ? DHLEN + TAGLEN : DHLEN
        const rs = this.symmetric.decryptAndHash(readSlice(message, offset, size))
        if (rs.length !== DHLEN) throw new NoiseError('invalid_message', 'bad static key length')
        if (this.rs !== undefined) throw new NoiseError('invalid_message', 'static key already set')
        this.rs = rs
        return offset + size
      }
      case 'ee':
        this.mixFromDh(this.requireEphemeral().privateKey, this.requireRe())
        return offset
      case 'es':
        if (this.initiator) {
          this.mixFromDh(this.requireEphemeral().privateKey, this.requireRs())
        } else {
          this.mixFromDh(this.staticKeypair.privateKey, this.requireRe())
        }
        return offset
      case 'se':
        if (this.initiator) {
          this.mixFromDh(this.staticKeypair.privateKey, this.requireRe())
        } else {
          this.mixFromDh(this.requireEphemeral().privateKey, this.requireRs())
        }
        return offset
      case 'ss':
        this.mixFromDh(this.staticKeypair.privateKey, this.requireRs())
        return offset
      case 'psk': {
        const psk = this.takePsk()
        this.symmetric.mixKeyAndHash(psk)
        return offset
      }
    }
  }

  private mixFromDh(privateKey: Uint8Array, publicKey: Uint8Array): void {
    const shared = dh(privateKey, publicKey)
    try {
      this.symmetric.mixKey(shared)
    } finally {
      // The DH output is a secret this handshake owns.
      shared.fill(0)
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
      ? { sendCipher: c1, recvCipher: c2, handshakeHash, remoteStatic }
      : { sendCipher: c2, recvCipher: c1, handshakeHash, remoteStatic }
    // Zeroize owned secrets: the ephemeral private key, ck, and handshake cipher key.
    this.e?.privateKey.fill(0)
    this.e = undefined
    this.symmetric.zeroize()
    this.psk = undefined
    this.ephemeralSecret = undefined
  }

  private assertActive(): void {
    if (this.handshakeResult !== undefined) {
      throw new NoiseError('handshake_exhausted', 'handshake already finished')
    }
  }

  private assertTurn(writing: boolean): void {
    const initiatorWritesThisPattern = this.patternIndex % 2 === 0
    const callerIsInitiatorWriter = writing ? this.initiator : !this.initiator
    if (initiatorWritesThisPattern !== callerIsInitiatorWriter) {
      throw new NoiseError('invalid_message', 'out-of-turn handshake call')
    }
  }

  private patternAt(): readonly Token[] {
    const pattern = MESSAGE_PATTERNS[this.patternIndex]
    if (pattern === undefined) throw new NoiseError('handshake_exhausted', 'no more message patterns')
    return pattern
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

function readSlice(message: Uint8Array, offset: number, size: number): Uint8Array {
  if (offset + size > message.length) throw new NoiseError('invalid_message', 'handshake message truncated')
  return message.slice(offset, offset + size)
}

export function createInitiatorHandshake(options: InitiatorHandshakeOptions): HandshakeState {
  return new HandshakeState({
    initiator: true,
    staticKey: options.staticKey,
    remoteStaticKey: options.remoteStaticKey,
    psk: options.psk,
    prologue: options.prologue,
    ephemeralSecret: options.ephemeralSecret,
  })
}

export function createResponderHandshake(options: ResponderHandshakeOptions): HandshakeState {
  return new HandshakeState({
    initiator: false,
    staticKey: options.staticKey,
    psk: options.psk,
    prologue: options.prologue,
    ephemeralSecret: options.ephemeralSecret,
  })
}
