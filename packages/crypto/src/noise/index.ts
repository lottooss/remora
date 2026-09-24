/**
 * Noise_IKpsk2_25519_ChaChaPoly_SHA256 for SC/1 (Crypto/1 §6), promoted from
 * the P0-S4 spike. Primitives come only from `@noble/*`; runtime-neutral
 * (Node and workerd).
 */
export { CipherState } from './cipher-state.ts'
export { NoiseError, type NoiseErrorCode } from './errors.ts'
export {
  HandshakeState,
  PROTOCOL_NAME,
  createInitiatorHandshake,
  createResponderHandshake,
  type HandshakeOptions,
  type HandshakeResult,
  type InitiatorHandshakeOptions,
  type ResponderHandshakeOptions,
} from './handshake-state.ts'
export {
  DHLEN,
  HASHLEN,
  MAX_NONCE,
  MAX_NOISE_MESSAGE,
  MAX_TRANSPORT_PAYLOAD,
  TAGLEN,
  decryptWithAd,
  dh,
  encryptWithAd,
  generateKeypair,
  hash,
  hkdf2,
  hkdf3,
  hmacHash,
  keypairFromPrivate,
  noiseNonce,
  utf8,
  type Keypair,
} from './primitives.ts'
export { SymmetricState } from './symmetric-state.ts'
