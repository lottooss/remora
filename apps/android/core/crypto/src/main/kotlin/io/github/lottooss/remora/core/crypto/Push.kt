package io.github.lottooss.remora.core.crypto

import java.security.SecureRandom

/** Pair identity authenticated alongside an encrypted push. */
data class PushContext(val hostId: String, val deviceId: String)

fun buildPushAad(context: PushContext): ByteArray {
    requireEndpointId(context.hostId, "host")
    requireEndpointId(context.deviceId, "device")
    return "remora/1 push\u0000${context.hostId}\u0000${context.deviceId}".toByteArray(Charsets.UTF_8)
}

fun sealPushPayload(devicePushKey: ByteArray, jsonPayload: String, context: PushContext): ByteArray {
    require(devicePushKey.size == 32) { "push: push key must be 32 bytes" }
    requireUnicode(jsonPayload)
    val plaintext = jsonPayload.toByteArray(Charsets.UTF_8)
    try {
        require(plaintext.size <= 2048) { "push: plaintext must not exceed 2048 bytes" }
        val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
        return nonce + encryptWithIv(devicePushKey, nonce, buildPushAad(context), plaintext)
    } finally { plaintext.fill(0) }
}

fun openPushPayload(devicePushKey: ByteArray, data: ByteArray, context: PushContext): String {
    require(devicePushKey.size == 32) { "push key must be 32 bytes" }
    require(data.size in 28..2076) { "push ciphertext size is invalid" }
    val plaintext = decryptWithIv(devicePushKey, data.copyOfRange(0, 12), buildPushAad(context), data.copyOfRange(12, data.size))
    return try { strictUtf8(plaintext) } finally { plaintext.fill(0) }
}
