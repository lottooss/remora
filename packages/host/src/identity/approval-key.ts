import { createPublicKey } from 'node:crypto'

const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')

/** Validate a P-256 key and return canonical uncompressed SubjectPublicKeyInfo. */
export function normalizeApprovalPublicKey(bytes: Uint8Array, allowLegacyPoint = false): Uint8Array {
  const input = allowLegacyPoint && bytes.length === 65 && bytes[0] === 0x04
    ? Buffer.concat([P256_SPKI_PREFIX, bytes])
    : Buffer.from(bytes)
  if (input.length !== 91 || !input.subarray(0, P256_SPKI_PREFIX.length).equals(P256_SPKI_PREFIX)) {
    throw new Error('approval public key must be uncompressed P-256 SPKI')
  }
  const key = createPublicKey({ key: input, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('approval public key must use P-256')
  }
  // JWK import asks OpenSSL to validate the actual curve point too.
  const canonical = createPublicKey({ key: key.export({ format: 'jwk' }), format: 'jwk' })
    .export({ format: 'der', type: 'spki' })
  if (!canonical.equals(input)) throw new Error('approval public key must be canonical DER')
  return new Uint8Array(canonical)
}
