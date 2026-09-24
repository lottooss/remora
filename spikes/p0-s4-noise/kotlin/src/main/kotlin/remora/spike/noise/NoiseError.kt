package remora.spike.noise

/**
 * Stable, snake_case error codes shared with the TypeScript twin and conformance vectors:
 * aead_verification_failed, nonce_exhausted, message_too_large, invalid_key_length,
 * invalid_message, invalid_public_key, handshake_incomplete, handshake_exhausted,
 * missing_key, psk_missing.
 */
class NoiseError(val code: String, message: String) : RuntimeException(message)
