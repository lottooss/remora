/** Noise rev. 34 §5.2 SymmetricState: CipherState plus ck and h. */
import { concatBytes } from '@noble/hashes/utils.js'
import { CipherState } from './cipher-state.ts'
import { HASHLEN, hash, hkdf2, hkdf3, utf8 } from './primitives.ts'

const EMPTY = new Uint8Array(0)

export class SymmetricState {
  readonly cipherState = new CipherState()
  private ck: Uint8Array
  private h: Uint8Array

  constructor(protocolName: string | Uint8Array) {
    const nameBytes = typeof protocolName === 'string' ? utf8(protocolName) : protocolName
    // §5.2 InitializeSymmetric: name ≤ HASHLEN is zero-padded into h, else h = HASH(name).
    this.h = nameBytes.length <= HASHLEN ? padTo(nameBytes, HASHLEN) : hash(nameBytes)
    this.ck = this.h.slice()
  }

  mixKey(ikm: Uint8Array): void {
    const [nextCk, tempK] = hkdf2(this.ck, ikm)
    this.ck.fill(0)
    this.ck = nextCk
    this.cipherState.initializeKey(tempK)
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(concatBytes(this.h, data))
  }

  /** §9.1 MixKeyAndHash: used only by the "psk" token. */
  mixKeyAndHash(ikm: Uint8Array): void {
    const [nextCk, tempH, tempK] = hkdf3(this.ck, ikm)
    this.ck.fill(0)
    this.ck = nextCk
    this.mixHash(tempH)
    tempH.fill(0)
    this.cipherState.initializeKey(tempK)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipherState.encryptWithAd(this.h, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipherState.decryptWithAd(this.h, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  /** §5.2 Split: (c1, c2) = HKDF(ck, zerolen, 2); c1 carries initiator → responder. */
  split(): [CipherState, CipherState] {
    const [tempK1, tempK2] = hkdf2(this.ck, EMPTY)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(tempK1)
    c2.initializeKey(tempK2)
    return [c1, c2]
  }

  getHandshakeHash(): Uint8Array {
    return this.h.slice()
  }

  /** Wipe ck and the handshake cipher key after Split(); h is public and kept. */
  zeroize(): void {
    this.ck.fill(0)
    this.cipherState.zeroize()
  }
}

function padTo(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(bytes)
  return out
}
