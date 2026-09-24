package io.github.lottooss.remora.core.crypto

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer

fun getRelayPublicKey(privateKey: ByteArray): ByteArray {
    require(privateKey.size == 32) { "private key must be 32 bytes" }
    return Ed25519PrivateKeyParameters(privateKey, 0).generatePublicKey().encoded
}

fun signRelayChallenge(privateKey: ByteArray, challengeToken: String): ByteArray {
    require(privateKey.size == 32) { "private key must be 32 bytes" }
    val msg = ("remora/1 relay-auth\u0000" + challengeToken).toByteArray(Charsets.UTF_8)
    val signer = Ed25519Signer()
    signer.init(true, Ed25519PrivateKeyParameters(privateKey, 0))
    signer.update(msg, 0, msg.size)
    return signer.generateSignature()
}

fun verifyRelayChallenge(publicKey: ByteArray, challengeToken: String, signature: ByteArray): Boolean {
    if (publicKey.size != 32 || signature.size != 64) return false
    return try {
        val msg = ("remora/1 relay-auth\u0000" + challengeToken).toByteArray(Charsets.UTF_8)
        val verifier = Ed25519Signer()
        verifier.init(false, Ed25519PublicKeyParameters(publicKey, 0))
        verifier.update(msg, 0, msg.size)
        verifier.verifySignature(signature)
    } catch (_: Exception) {
        false
    }
}
