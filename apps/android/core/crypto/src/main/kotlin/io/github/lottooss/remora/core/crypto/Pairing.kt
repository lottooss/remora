package io.github.lottooss.remora.core.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter

data class PairingData(
    val relayOrigin: String,
    val hostId: String,
    val hostNoisePub: ByteArray,
    val ticket: ByteArray,
    val pairingSecret: ByteArray,
    val hostName: String,
    val expiry: Long,
)

private const val QR_PREFIX = "remora://pair?"
private val QR_PARAM_KEYS = setOf("v", "r", "h", "k", "t", "s", "n", "x")

fun parsePairingQr(qr: String, nowSeconds: Long? = null): PairingData {
    require(qr.length <= 4096) { "pairing: QR is too large" }
    require(qr.startsWith(QR_PREFIX)) { "pairing: QR must start with remora://pair?" }
    require(!qr.contains("#")) { "pairing: QR must not contain a fragment" }
    val segments = qr.substring(QR_PREFIX.length).split("&")
    val params = mutableMapOf<String, String>()
    for (segment in segments) {
        require(segment.isNotEmpty()) { "pairing: empty query segment" }
        val eq = segment.indexOf('=')
        require(eq > 0) { "pairing: malformed query segment" }
        val key = segment.substring(0, eq)
        require(!params.containsKey(key)) { "pairing: duplicate query parameter" }
        params[key] = segment.substring(eq + 1)
    }
    for (k in params.keys) {
        require(QR_PARAM_KEYS.contains(k)) { "pairing: unknown query parameter" }
    }
    fun getVal(key: String): String {
        val raw = params[key] ?: throw IllegalArgumentException("pairing: missing query parameter $key")
        return try {
            decodeQrValue(raw)
        } catch (e: Exception) {
            throw IllegalArgumentException("pairing: malformed percent-encoding", e)
        }
    }
    require(getVal("v") == "1") { "pairing: unsupported QR version" }
    val relayOrigin = getVal("r")
    val hostId = getVal("h")
    val hostNoisePub = decodeBase64Url(getVal("k"))
    val ticket = decodeBase64Url(getVal("t"))
    val pairingSecret = decodeBase64Url(getVal("s"))
    val hostName = getVal("n")
    val expiryStr = getVal("x")
    require(expiryStr.matches(Regex("^\\d+$"))) { "pairing: expiry must be unix seconds" }
    val expiry = expiryStr.toLong()

    require(hostNoisePub.size == 32) { "pairing: hostNoisePub must be 32 bytes" }
    require(ticket.size == 32) { "pairing: ticket must be 32 bytes" }
    require(pairingSecret.size == 32) { "pairing: pairingSecret must be 32 bytes" }
    require(hostName.isNotEmpty() && hostName.length <= 40) { "pairing: host name must be 1-40 characters" }

    requireRelayOrigin(relayOrigin)
    requireEndpointId(hostId, "host")
    requireUnicode(hostName)
    require(hostName.none { it.code < 32 || it.code == 127 }) { "pairing: host name contains controls" }
    require(expiry in 1L..9_007_199_254_740_991L) { "pairing: expiry is invalid" }
    require(nowSeconds == null || expiry > nowSeconds) { "pairing: QR expired" }

    return PairingData(
        relayOrigin = relayOrigin,
        hostId = hostId,
        hostNoisePub = hostNoisePub,
        ticket = ticket,
        pairingSecret = pairingSecret,
        hostName = hostName,
        expiry = expiry,
    )
}

fun buildPairingQr(data: PairingData): String {
    require(data.hostNoisePub.size == 32) { "pairing: hostNoisePub must be 32 bytes" }
    require(data.ticket.size == 32) { "pairing: ticket must be 32 bytes" }
    require(data.pairingSecret.size == 32) { "pairing: pairingSecret must be 32 bytes" }
    require(data.hostName.isNotEmpty() && data.hostName.length <= 40) { "pairing: host name must be 1-40 characters" }
    require(data.expiry > 0) { "pairing: expiry must be positive" }

    requireRelayOrigin(data.relayOrigin)
    requireEndpointId(data.hostId, "host")
    requireUnicode(data.hostName)
    require(data.hostName.none { it.code < 32 || it.code == 127 }) { "pairing: host name contains controls" }
    require(data.expiry <= 9_007_199_254_740_991L) { "pairing: expiry is invalid" }
    fun enc(v: String) = encodeQrValue(v)
    return "$QR_PREFIX" +
            "v=1" +
            "&r=${enc(data.relayOrigin)}" +
            "&h=${enc(data.hostId)}" +
            "&k=${enc(encodeBase64Url(data.hostNoisePub))}" +
            "&t=${enc(encodeBase64Url(data.ticket))}" +
            "&s=${enc(encodeBase64Url(data.pairingSecret))}" +
            "&n=${enc(data.hostName)}" +
            "&x=${data.expiry}"
}

/** Host-bound HKDF-SHA256 pairing secret (Crypto/1 §5.2). */
fun derivePairPsk(pairingSecret: ByteArray, hostId: String): ByteArray {
    require(pairingSecret.size == 32) { "pairing: pairing secret must be 32 bytes" }
    requireEndpointId(hostId, "host")
    val hkdf = HKDFBytesGenerator(SHA256Digest())
    hkdf.init(HKDFParameters(pairingSecret, "remora/1".toByteArray(Charsets.UTF_8), ("pair-psk\u0000" + hostId).toByteArray(Charsets.UTF_8)))
    return ByteArray(32).also { hkdf.generateBytes(it, 0, it.size) }
}

/** Six digits from the completed Noise transcript (Crypto/1 §5.3). */
fun deriveSasCode(handshakeHash: ByteArray): String {
    require(handshakeHash.size == 32) { "pairing: handshake hash must be 32 bytes" }
    val hmac = HMac(SHA256Digest())
    hmac.init(KeyParameter(handshakeHash))
    val msg = "remora/1 sas".toByteArray(Charsets.UTF_8)
    hmac.update(msg, 0, msg.size)
    val out = ByteArray(32)
    hmac.doFinal(out, 0)
    val value = ((out[0].toLong() and 255) shl 24) or ((out[1].toLong() and 255) shl 16) or
        ((out[2].toLong() and 255) shl 8) or (out[3].toLong() and 255)
    return (value % 1_000_000).toString().padStart(6, '0')
}

private fun decodeQrValue(raw: String): String {
    requireUnicode(raw)
    val out = java.io.ByteArrayOutputStream()
    var index = 0
    while (index < raw.length) {
        if (raw[index] == '%') {
            require(index + 2 < raw.length) { "Malformed percent encoding" }
            val hex = raw.substring(index + 1, index + 3)
            require(hex.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) { "Malformed percent encoding" }
            out.write(hex.toInt(16)); index += 3
        } else {
            val end = raw.indexOf('%', index).let { if (it == -1) raw.length else it }
            out.write(raw.substring(index, end).toByteArray(Charsets.UTF_8)); index = end
        }
    }
    return strictUtf8(out.toByteArray())
}

private fun encodeQrValue(value: String): String {
    requireUnicode(value)
    val safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
    return buildString {
        for (byte in value.toByteArray(Charsets.UTF_8)) {
            val unsigned = byte.toInt() and 255
            if (unsigned.toChar() in safe) append(unsigned.toChar())
            else append('%').append(unsigned.toString(16).uppercase().padStart(2, '0'))
        }
    }
}
