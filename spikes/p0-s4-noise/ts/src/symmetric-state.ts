/** Noise rev. 34 §5.2 SymmetricState: CipherState plus ck and h. */
import { CipherState } from './cipher-state.ts'
import { NoiseError } from './errors.ts'
import { HASHLEN, hash, hkdf, utf8 } from './primitives.ts'

export class SymmetricState {
  readonly cipherState = new CipherState()
  private chainingKey: Uint8Array
  private handshakeHash: Uint8Array

  constructor(protocolName: string | Uint8Array) {
    const nameBytes = typeof protocolName === 'string' ? utf8(protocolName) : protocolName
    // §5.2 InitializeSymmetric: name ≤ HASHLEN is zero-padded into h, else h = HASH(name).
    this.handshakeHash = nameBytes.length <= HASHLEN ? padTo(nameBytes, HASHLEN) : hash(nameBytes)
    this.chainingKey = this.handshakeHash.slice()
    this.cipherState.initializeKey(null)
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.chainingKey, inputKeyMaterial, 2)
    this.chainingKey = ck
    this.cipherState.initializeKey(tempK)
  }

  mixHash(data: Uint8Array): void {
    this.handshakeHash = hash(this.handshakeHash, data)
  }

  /** §9.1 MixKeyAndHash: used only by the "psk" token. */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf(this.chainingKey, inputKeyMaterial, 3)
    this.chainingKey = ck
    this.mixHash(tempH)
    this.cipherState.initializeKey(tempK)
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipherState.encryptWithAd(this.handshakeHash, plaintext)
    this.mixHash(ciphertext)
    return ciphertext
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipherState.decryptWithAd(this.handshakeHash, ciphertext)
    this.mixHash(ciphertext)
    return plaintext
  }

  /** §5.2 Split: (c1, c2) = HKDF(ck, zerolen, 2); c1 carries initiator → responder. */
  split(): [CipherState, CipherState] {
    const [tempK1, tempK2] = hkdf(this.chainingKey, new Uint8Array(0), 2)
    const c1 = new CipherState()
    const c2 = new CipherState()
    c1.initializeKey(tempK1)
    c2.initializeKey(tempK2)
    return [c1, c2]
  }

  getHandshakeHash(): Uint8Array {
    if (this.chainingKey.length !== HASHLEN) throw new NoiseError('invalid_key_length', 'bad chaining key')
    return this.handshakeHash.slice()
  }
}

function padTo(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(bytes)
  return out
}
