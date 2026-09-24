package io.github.lottooss.remora.core.crypto

import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.macs.HMac
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

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

fun parsePairingQr(qr: String): PairingData {
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
            URLDecoder.decode(raw, "UTF-8")
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

    val originUri = URI(relayOrigin)
    require(originUri.scheme == "https" || (originUri.scheme == "http" && (originUri.host == "127.0.0.1" || originUri.host == "10.0.2.2"))) {
        "pairing: relay origin must be https (http allowed only for 127.0.0.1 / 10.0.2.2)"
    }
    require(originUri.path.isNullOrEmpty() || originUri.path == "/") {
        "pairing: relay origin must contain no path or fragment"
    }

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

    val originUri = URI(data.relayOrigin)
    require(originUri.scheme == "https" || (originUri.scheme == "http" && (originUri.host == "127.0.0.1" || originUri.host == "10.0.2.2"))) {
        "pairing: relay origin must be https (http allowed only for 127.0.0.1 / 10.0.2.2)"
    }
    require(originUri.path.isNullOrEmpty() || originUri.path == "/") {
        "pairing: relay origin must contain no path or fragment"
    }

    fun enc(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")
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

fun derivePairPsk(pairingSecret: ByteArray, ticketId: String): ByteArray {
    require(pairingSecret.size == 32) { "pairing: pairing secret must be 32 bytes" }
    val hkdf = HKDFBytesGenerator(SHA256Digest())
    val salt = "remora/1".toByteArray(Charsets.UTF_8)
    val info = ("pair-psk\u0000" + ticketId).toByteArray(Charsets.UTF_8)
    hkdf.init(HKDFParameters(pairingSecret, salt, info))
    val out = ByteArray(32)
    hkdf.generateBytes(out, 0, 32)
    return out
}

fun deriveSasCode(hostNoisePub: ByteArray, deviceNoisePub: ByteArray, psk: ByteArray): String {
    require(hostNoisePub.size == 32) { "pairing: hostNoisePub must be 32 bytes" }
    require(deviceNoisePub.size == 32) { "pairing: deviceNoisePub must be 32 bytes" }
    require(psk.size == 32) { "pairing: psk must be 32 bytes" }
    val hmac = HMac(SHA256Digest())
    hmac.init(KeyParameter(psk))
    val prefix = "remora/1 sas\u0000".toByteArray(Charsets.UTF_8)
    val msg = prefix + hostNoisePub + deviceNoisePub
    hmac.update(msg, 0, msg.size)
    val out = ByteArray(32)
    hmac.doFinal(out, 0)
    val value = (((out[0].toLong() and 0xff) shl 24) or
            ((out[1].toLong() and 0xff) shl 16) or
            ((out[2].toLong() and 0xff) shl 8) or
            (out[3].toLong() and 0xff)) and 0xffffffffL
    return (value % 1_000_000).toString().padStart(6, '0')
}
