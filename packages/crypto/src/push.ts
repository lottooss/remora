import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { randomBytes } from './random.ts'

const PUSH_KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const MAX_PUSH_PAYLOAD_BYTES = 2_048

/**
 * Seals a JSON push payload with ChaCha20-Poly1305 (IETF, 96-bit nonce):
 * `nonce ‖ ciphertext`, 12 random nonce bytes prepended (Crypto/1 §8, minus
 * the AAD fields this two-argument API does not bind). Plaintext is UTF-8
 * JSON and MUST be ≤ 2,048 bytes.
 */
export function sealPushPayload(devicePushKey: Uint8Array, payload: unknown): Uint8Array {
  if (devicePushKey.length !== PUSH_KEY_BYTES) throw new Error('push: push key must be 32 bytes')
  const json: string | undefined = JSON.stringify(payload)
  if (json === undefined) throw new Error('push: payload must be JSON-serializable')
  const plaintext = utf8ToBytes(json)
  if (plaintext.length > MAX_PUSH_PAYLOAD_BYTES) {
    plaintext.fill(0)
    throw new Error(`push: plaintext must not exceed ${MAX_PUSH_PAYLOAD_BYTES} bytes`)
  }
  try {
    const nonce = randomBytes(NONCE_BYTES)
    const ciphertext = chacha20poly1305(devicePushKey, nonce).encrypt(plaintext)
    const out = new Uint8Array(NONCE_BYTES + ciphertext.length)
    out.set(nonce, 0)
    out.set(ciphertext, NONCE_BYTES)
    return out
  } finally {
    plaintext.fill(0)
  }
}

/**
 * Opens a sealed push payload: verifies the Poly1305 tag, strictly decodes
 * UTF-8, and parses JSON. Any failure throws (fail closed).
 */
export function openPushPayload(devicePushKey: Uint8Array, data: Uint8Array): unknown {
  if (devicePushKey.length !== PUSH_KEY_BYTES) throw new Error('push: push key must be 32 bytes')
  if (data.length < NONCE_BYTES + TAG_BYTES) throw new Error('push: ciphertext is too short')
  const nonce = data.subarray(0, NONCE_BYTES)
  const ciphertext = data.subarray(NONCE_BYTES)
  const plaintext = chacha20poly1305(devicePushKey, nonce).decrypt(ciphertext)
  try {
    const json = new TextDecoder().decode(plaintext)
    const parsed: unknown = JSON.parse(json)
    return parsed
  } finally {
    plaintext.fill(0)
  }
}
