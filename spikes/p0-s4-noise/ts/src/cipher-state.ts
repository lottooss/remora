/** Noise rev. 34 §5.1 CipherState: the (k, n) AEAD counter state. */
import { NoiseError } from './errors.ts'
import { DHLEN, decrypt, encrypt } from './primitives.ts'

const MAX_NONCE = (1n << 64n) - 1n

export class CipherState {
  private key: Uint8Array | null = null
  private counter = 0n

  initializeKey(key?: Uint8Array | null): void {
    if (key !== undefined && key !== null && key.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'cipher key must be 32 bytes')
    }
    this.key = key === undefined || key === null ? null : key.slice()
    this.counter = 0n
  }

  hasKey(): boolean {
    return this.key !== null
  }

  /** Current 64-bit nonce (test/diagnostic access). */
  get nonce(): bigint {
    return this.counter
  }

  /** §5.1 SetNonce: used by tests to reach exhaustion quickly; SC/1 never reorders. */
  setNonce(nonce: bigint): void {
    if (nonce < 0n || nonce > MAX_NONCE) throw new NoiseError('nonce_exhausted', 'nonce out of range')
    this.counter = nonce
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === null) return plaintext
    this.assertNonce()
    const ciphertext = encrypt(this.key, this.counter, ad, plaintext)
    this.counter += 1n
    return ciphertext
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === null) return ciphertext
    this.assertNonce()
    // On authentication failure n must NOT advance (§5.1).
    const plaintext = decrypt(this.key, this.counter, ad, ciphertext)
    this.counter += 1n
    return plaintext
  }

  /** Best-effort wipe of the key material this object owns. */
  zeroize(): void {
    this.key?.fill(0)
    this.key = null
    this.counter = 0n
  }

  private assertNonce(): void {
    // The maximum n (2^64-1) is reserved; reaching it means exhaustion (§5.1).
    if (this.counter >= MAX_NONCE) throw new NoiseError('nonce_exhausted', 'transport nonce exhausted')
  }
}
