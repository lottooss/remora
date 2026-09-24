import { sha256 } from '@noble/hashes/sha2.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { encodeBase32 } from './base32.ts'

/**
 * Derives an endpoint id from the endpoint's 32-byte Ed25519 relay public key
 * (Crypto/1 §2):
 *
 * `prefix ‖ base32(SHA-256("remora/1 endpoint-id" ‖ 0x00 ‖ relayPub)[0..16])`
 *
 * The result is 28 characters: `h_`/`d_` plus 26 base32 characters. The relay
 * recomputes the id at enrollment and on every authentication.
 */
export function deriveEndpointId(prefix: 'h_' | 'd_', relayPublicKey: Uint8Array): string {
  if (prefix !== 'h_' && prefix !== 'd_') throw new Error('endpoint-id: prefix must be "h_" or "d_"')
  if (relayPublicKey.length !== 32) throw new Error('endpoint-id: relay public key must be 32 bytes')
  const message = concatBytes(utf8ToBytes('remora/1 endpoint-id'), Uint8Array.of(0x00), relayPublicKey)
  return prefix + encodeBase32(sha256(message).subarray(0, 16))
}
