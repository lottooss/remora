package io.github.lottooss.remora.core.crypto

/**
 * Kotlin twin of @remora/crypto (Crypto/1): Noise IKpsk2 over BouncyCastle
 * primitives, identities, relay auth, pairing, approval messages, push AEAD.
 * Implementation: spike P0-S4, then task P1-K1.
 */
object Crypto {
    const val NOISE_PROTOCOL_NAME = "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
    const val DOMAIN_PREFIX = "remora/1"
}
