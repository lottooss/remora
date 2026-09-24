/** Stable, snake_case error codes shared with the Kotlin twin and conformance vectors. */
export type NoiseErrorCode =
  | 'aead_verification_failed'
  | 'nonce_exhausted'
  | 'message_too_large'
  | 'invalid_key_length'
  | 'invalid_message'
  | 'invalid_public_key'
  | 'handshake_incomplete'
  | 'handshake_exhausted'
  | 'missing_key'
  | 'psk_missing'

export class NoiseError extends Error {
  readonly code: NoiseErrorCode

  constructor(code: NoiseErrorCode, message: string) {
    super(message)
    this.name = 'NoiseError'
    this.code = code
  }
}
