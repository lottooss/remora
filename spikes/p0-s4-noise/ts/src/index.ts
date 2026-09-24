/**
 * P0-S4 spike: Noise_IKpsk2_25519_ChaChaPoly_SHA256 over @noble/* 2.x.
 * Throwaway prototype for the future `@remora/crypto` package (see docs/spikes/P0-S4.md).
 */
export { CipherState } from './cipher-state.ts'
export { NoiseError, type NoiseErrorCode } from './errors.ts'
export { decodeHex, bytesToHex, hexToBytes } from './hex.ts'
export {
  HandshakeState,
  PROTOCOL_NAME,
  type HandshakeOptions,
  type HandshakeResult,
} from './handshake-state.ts'
export {
  DHLEN,
  HASHLEN,
  MAX_NOISE_MESSAGE,
  MAX_TRANSPORT_PAYLOAD,
  TAGLEN,
  decrypt,
  dh,
  encrypt,
  generateKeypair,
  hash,
  hkdf,
  hmacHash,
  keypairFromSecret,
  noiseNonce,
  utf8,
  type Keypair,
} from './primitives.ts'
export { SymmetricState } from './symmetric-state.ts'
