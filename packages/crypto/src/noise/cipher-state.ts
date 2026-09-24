/** Noise rev. 34 §5.1 CipherState: the (k, n) AEAD counter state. */
import { NoiseError } from './errors.ts'
import { DHLEN, MAX_NONCE, decryptWithAd, encryptWithAd } from './primitives.ts'

const EMPTY = new Uint8Array(0)

export class CipherState {
  private k: Uint8Array | null = null
  private n = 0n

  /** §5.1 InitializeKey: takes ownership of `key` (the caller must not reuse it). */
  initializeKey(key?: Uint8Array | null): void {
    if (key !== undefined && key !== null && key.length !== DHLEN) {
      throw new NoiseError('invalid_key_length', 'cipher key must be 32 bytes')
    }
    if (this.k !== null && this.k !== key) this.k.fill(0)
    this.k = key === undefined || key === null ? null : key
    this.n = 0n
  }

  hasKey(): boolean {
    return this.k !== null
  }

  /** Current 64-bit nonce (diagnostic and test access). */
  get nonce(): bigint {
    return this.n
  }

  /** §5.1 SetNonce: used for out-of-order transport (§11.4) and tests. */
  setNonce(nonce: bigint): void {
    if (nonce < 0n || nonce > MAX_NONCE) throw new NoiseError('nonce_exhausted', 'nonce out of range')
    this.n = nonce
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext
    this.assertNonce()
    const ciphertext = encryptWithAd(this.k, this.n, ad, plaintext)
    this.n += 1n
    return ciphertext
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext
    this.assertNonce()
    // On authentication failure n must NOT advance (§5.1).
    const plaintext = decryptWithAd(this.k, this.n, ad, ciphertext)
    this.n += 1n
    return plaintext
  }

  /**
   * §5.1 Rekey (via §4.2 REKEY): k = ENCRYPT(k, 2^64−1, zerolen, zeros32)[0..32].
   * Does not reset n (§11.3); the caller coordinates rekey with the peer.
   */
  rekey(): void {
    if (this.k === null) throw new NoiseError('missing_key', 'cannot rekey a CipherState without a key')
    const stretched = encryptWithAd(this.k, MAX_NONCE, EMPTY, new Uint8Array(DHLEN))
    const next = stretched.slice(0, DHLEN)
    this.k.fill(0)
    this.k = next
  }

  /** Best-effort wipe of the key material this object owns. */
  zeroize(): void {
    this.k?.fill(0)
    this.k = null
    this.n = 0n
  }

  private assertNonce(): void {
    // The maximum n (2^64−1) is reserved; reaching it means exhaustion (§5.1).
    if (this.n >= MAX_NONCE) throw new NoiseError('nonce_exhausted', 'transport nonce exhausted')
  }
}
