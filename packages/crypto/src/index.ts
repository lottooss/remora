/**
 * @remora/crypto — every construction in docs/specs/crypto-v1.md: Noise IKpsk2
 * secure channel, endpoint identities, relay authentication, pairing (QR, PSK,
 * SAS), approval signature verification, and push payload AEAD.
 *
 * Implementation: spike P0-S4, then task P1-C1. Primitives come only from
 * `@noble/curves`, `@noble/ciphers`, and `@noble/hashes`. Runtime-neutral.
 */

/** Noise protocol name for SC/1 (Crypto/1 §6). */
export const NOISE_PROTOCOL_NAME = 'Noise_IKpsk2_25519_ChaChaPoly_SHA256'

/** Domain-separation prefix used in prologues, HKDF info, and signed messages. */
export const DOMAIN_PREFIX = 'remora/1'

/** Endpoint id prefixes (Crypto/1 §2). */
export const ENDPOINT_ID_PREFIX = { host: 'h_', device: 'd_' } as const

export * from './noise/index.ts'
export * from './context.ts'
export * from './b64u.ts'
export * from './base32.ts'
export * from './random.ts'
export * from './ids.ts'
export * from './relay-auth.ts'
export * from './pairing.ts'
export * from './approval.ts'
export * from './push.ts'
export { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js'
