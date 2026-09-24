/**
 * Primitive wrappers for Noise_IKpsk2_25519_ChaChaPoly_SHA256 (Noise rev. 34 §4, §12).
 * All math comes from @noble/*; this module only assembles them into the
 * framework's DH / cipher / hash / HKDF contracts. No primitive is implemented here.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { NoiseError } from './errors.ts'

export const DHLEN = 32
export const HASHLEN = 32
export const TAGLEN = 16
/** Noise rev. 34 §3: every handshake and transport message is ≤ 65535 bytes. */
export const MAX_NOISE_MESSAGE = 65535
/** Largest transport plaintext: 65535 minus the 16-byte AEAD tag. */
export const MAX_TRANSPORT_PAYLOAD = MAX_NOISE_MESSAGE - TAGLEN

const MAX_NONCE = (1n << 64n) - 1n

export interface Keypair {
  readonly secretKey: Uint8Array
  readonly publicKey: Uint8Array
}

export function generateKeypair(): Keypair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

export function keypairFromSecret(secretKey: Uint8Array): Keypair {
  if (secretKey.length !== DHLEN) throw new NoiseError('invalid_key_length', 'X25519 secret key must be 32 bytes')
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** DH(key_pair, public_key): 32-byte shared secret; noble rejects all-zero (low-order) results. */
export function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (secretKey.length !== DHLEN || publicKey.length !== DHLEN) {
    throw new NoiseError('invalid_key_length', 'X25519 keys must be 32 bytes')
  }
  try {
    return x25519.getSharedSecret(secretKey, publicKey)
  } catch (error) {
    throw new NoiseError('invalid_public_key', `X25519 DH failed: ${error instanceof Error ? error.message : 'unknown'}`)
  }
}

export function hash(...data: Uint8Array[]): Uint8Array {
  return sha256(data.length === 1 ? (data[0] as Uint8Array) : concatBytes(...data))
}

export function hmacHash(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data)
}

/**
 * Noise rev. 34 §4.3 HKDF: temp_key = HMAC(ck, ikm); outputs are the HMAC chain
 * 0x01, 0x02, 0x03. Distinct from RFC 5869 only in call convention, not in math.
 */
export function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2): [Uint8Array, Uint8Array]
export function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 3): [Uint8Array, Uint8Array, Uint8Array]
export function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array, outputs: 2 | 3): Uint8Array[] {
  const tempKey = hmacHash(chainingKey, inputKeyMaterial)
  const output1 = hmacHash(tempKey, Uint8Array.of(0x01))
  const output2 = hmacHash(tempKey, concatBytes(output1, Uint8Array.of(0x02)))
  if (outputs === 2) return [output1, output2]
  const output3 = hmacHash(tempKey, concatBytes(output2, Uint8Array.of(0x03)))
  return [output1, output2, output3]
}

/**
 * Noise rev. 34 §12.3: the 96-bit ChaCha20 nonce is 32 zero bits followed by
 * the 64-bit counter n in little-endian order (NOT big-endian; AESGCM is the
 * big-endian sibling).
 */
export function noiseNonce(n: bigint): Uint8Array {
  if (n < 0n || n > MAX_NONCE) throw new NoiseError('nonce_exhausted', 'Noise nonce out of 64-bit range')
  const nonce = new Uint8Array(12)
  const view = new DataView(nonce.buffer)
  view.setBigUint64(4, n, true)
  return nonce
}

/** ENCRYPT(k, n, ad, plaintext) with ChaCha20-Poly1305 (RFC 8439 AEAD). */
export function encrypt(
  key: Uint8Array,
  n: bigint,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  if (key.length !== DHLEN) throw new NoiseError('invalid_key_length', 'cipher key must be 32 bytes')
  return chacha20poly1305(key, noiseNonce(n), ad).encrypt(plaintext)
}

/** DECRYPT(k, n, ad, ciphertext); any tag mismatch raises. */
export function decrypt(key: Uint8Array, n: bigint, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (key.length !== DHLEN) throw new NoiseError('invalid_key_length', 'cipher key must be 32 bytes')
  try {
    return chacha20poly1305(key, noiseNonce(n), ad).decrypt(ciphertext)
  } catch (error) {
    throw new NoiseError('aead_verification_failed', `ChaCha20-Poly1305 verification failed`)
  }
}

export function utf8(text: string): Uint8Array {
  return utf8ToBytes(text)
}
