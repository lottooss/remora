import { ed25519 } from '@noble/curves/ed25519.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

/** Domain label + 0x00 separator preceding the challenge token (Crypto/1 §4). */
const RELAY_AUTH_LABEL = 'remora/1 relay-auth\x00'

function relayAuthMessage(challengeToken: string): Uint8Array {
  return utf8ToBytes(RELAY_AUTH_LABEL + challengeToken)
}

/**
 * Derives the 32-byte Ed25519 public key from the private key seed (Crypto/1 §4).
 */
export function getRelayPublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new Error('relay-auth: private key must be a 32-byte Ed25519 seed')
  return ed25519.getPublicKey(privateKey)
}

/**
 * Signs a relay authentication challenge with the endpoint's Ed25519 relay key
 * seed (Crypto/1 §4). `challengeToken` carries the challenge bytes after the
 * domain label: for the full §4 message it is
 * `relayOrigin ‖ 0x00 ‖ kind ‖ 0x00 ‖ endpointId ‖ 0x00 ‖ nonce`.
 */
export function signRelayChallenge(privateKey: Uint8Array, challengeToken: string): Uint8Array {
  if (privateKey.length !== 32) throw new Error('relay-auth: private key must be a 32-byte Ed25519 seed')
  return ed25519.sign(relayAuthMessage(challengeToken), privateKey)
}

/**
 * Verifies a relay authentication signature. Malformed keys, signatures, or
 * tokens fail closed to `false`.
 */
export function verifyRelayChallenge(
  publicKey: Uint8Array,
  challengeToken: string,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try {
    return ed25519.verify(signature, relayAuthMessage(challengeToken), publicKey)
  } catch {
    return false
  }
}
