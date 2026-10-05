import { ed25519 } from '@noble/curves/ed25519.js'
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { assertEndpointId, assertRelayOrigin } from './context.ts'

/** Connection context authenticated by Crypto/1 §4. Nonce is decoded raw bytes. */
export interface RelayAuthFields {
  relayOrigin: string
  kind: 'host' | 'device'
  endpointId: string
  nonce: Uint8Array
}

/** Constructs the exact context-bound relay authentication bytes. */
export function buildRelayAuthMessage(fields: RelayAuthFields): Uint8Array {
  assertRelayOrigin(fields.relayOrigin)
  if (fields.kind !== 'host' && fields.kind !== 'device') throw new Error('relay-auth: invalid kind')
  assertEndpointId(fields.endpointId, fields.kind)
  if (fields.nonce.length !== 32) throw new Error('relay-auth: nonce must be 32 bytes')
  return concatBytes(utf8ToBytes(`remora/1 relay-auth\x00${fields.relayOrigin}\x00${fields.kind}\x00${fields.endpointId}\x00`), fields.nonce)
}

/** Derives the endpoint's Ed25519 public key from its private seed. */
export function getRelayPublicKey(privateKey: Uint8Array): Uint8Array {
  if (privateKey.length !== 32) throw new Error('relay-auth: private key must be a 32-byte Ed25519 seed')
  return ed25519.getPublicKey(privateKey)
}

/** Signs this connection's origin, endpoint identity and nonce. */
export function signRelayChallenge(privateKey: Uint8Array, fields: RelayAuthFields): Uint8Array {
  if (privateKey.length !== 32) throw new Error('relay-auth: private key must be a 32-byte Ed25519 seed')
  return ed25519.sign(buildRelayAuthMessage(fields), privateKey)
}

/** Fails closed on malformed contexts, keys or signatures. */
export function verifyRelayChallenge(publicKey: Uint8Array, fields: RelayAuthFields, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false
  try { return ed25519.verify(signature, buildRelayAuthMessage(fields), publicKey) }
  catch { return false }
}
