package io.github.lottooss.remora.core.crypto

import java.security.SecureRandom

fun sealPushPayload(devicePushKey: ByteArray, jsonPayload: String): ByteArray {
    require(devicePushKey.size == 32) { "push: push key must be 32 bytes" }
    val plaintext = jsonPayload.toByteArray(Charsets.UTF_8)
    require(plaintext.size <= 2048) { "push: plaintext must not exceed 2048 bytes" }
    val nonce = ByteArray(12)
    SecureRandom().nextBytes(nonce)
    val ciphertext = encryptWithIv(devicePushKey, nonce, ByteArray(0), plaintext)
    return nonce + ciphertext
}

fun openPushPayload(devicePushKey: ByteArray, data: ByteArray): String {
    require(devicePushKey.size == 32) { "push key must be 32 bytes" }
    require(data.size >= 12 + 16) { "data too short" }
    val nonce = data.copyOfRange(0, 12)
    val ciphertext = data.copyOfRange(12, data.size)
    val plaintext = decryptWithIv(devicePushKey, nonce, ByteArray(0), ciphertext)
    return String(plaintext, Charsets.UTF_8)
}

