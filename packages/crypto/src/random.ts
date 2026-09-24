/**
 * CSPRNG bytes from `crypto.getRandomValues` (Crypto/1 §1). Randomness only
 * ever comes from here — never `Math.random`.
 */

/** Web Crypto allows at most 65,536 bytes per `getRandomValues` call. */
const GET_RANDOM_VALUES_CHUNK = 65_536

/** Returns `length` cryptographically secure random bytes. */
export function randomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error('randomBytes: length must be a non-negative integer')
  }
  const out = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += GET_RANDOM_VALUES_CHUNK) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + GET_RANDOM_VALUES_CHUNK, length)))
  }
  return out
}
