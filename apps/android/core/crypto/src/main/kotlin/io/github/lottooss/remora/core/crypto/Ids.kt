package io.github.lottooss.remora.core.crypto

fun deriveEndpointId(prefix: String, relayPublicKey: ByteArray): String {
    require(prefix == "h_" || prefix == "d_") { "prefix must be h_ or d_" }
    require(relayPublicKey.size == 32) { "relay public key must be 32 bytes" }
    val label = "remora/1 endpoint-id\u0000".toByteArray(Charsets.UTF_8)
    val hash = sha256(label + relayPublicKey)
    val idBytes = hash.copyOfRange(0, 16)
    return prefix + encodeBase32(idBytes)
}
