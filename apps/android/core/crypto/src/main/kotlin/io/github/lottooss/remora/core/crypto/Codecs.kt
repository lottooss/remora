package io.github.lottooss.remora.core.crypto

private const val HEX_CHARS = "0123456789abcdef"

fun decodeHex(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "hex string must have even length" }
    require(hex.all { it in '0'..'9' || it in 'a'..'f' }) { "hex string must be lowercase" }
    return ByteArray(hex.length / 2) { i ->
        val hi = Character.digit(hex[i * 2], 16)
        val lo = Character.digit(hex[i * 2 + 1], 16)
        ((hi shl 4) or lo).toByte()
    }
}

fun encodeHex(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    bytes.forEachIndexed { i, b ->
        val v = b.toInt() and 0xff
        out[i * 2] = HEX_CHARS[v shr 4]
        out[i * 2 + 1] = HEX_CHARS[v and 0x0f]
    }
    return String(out)
}

// Unpadded Base64Url (RFC 4648 §5)
private const val B64U_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
private val B64U_DECODE = IntArray(128) { -1 }.apply {
    for (i in B64U_ALPHABET.indices) this[B64U_ALPHABET[i].code] = i
}

fun encodeBase64Url(bytes: ByteArray): String {
    val sb = java.lang.StringBuilder()
    var i = 0
    while (i + 3 <= bytes.size) {
        val n = ((bytes[i].toInt() and 0xff) shl 16) or
                ((bytes[i + 1].toInt() and 0xff) shl 8) or
                (bytes[i + 2].toInt() and 0xff)
        sb.append(B64U_ALPHABET[(n ushr 18) and 63])
        sb.append(B64U_ALPHABET[(n ushr 12) and 63])
        sb.append(B64U_ALPHABET[(n ushr 6) and 63])
        sb.append(B64U_ALPHABET[n and 63])
        i += 3
    }
    val rem = bytes.size - i
    if (rem == 1) {
        val n = (bytes[i].toInt() and 0xff) shl 16
        sb.append(B64U_ALPHABET[(n ushr 18) and 63])
        sb.append(B64U_ALPHABET[(n ushr 12) and 63])
    } else if (rem == 2) {
        val n = ((bytes[i].toInt() and 0xff) shl 16) or ((bytes[i + 1].toInt() and 0xff) shl 8)
        sb.append(B64U_ALPHABET[(n ushr 18) and 63])
        sb.append(B64U_ALPHABET[(n ushr 12) and 63])
        sb.append(B64U_ALPHABET[(n ushr 6) and 63])
    }
    return sb.toString()
}

fun decodeBase64Url(str: String): ByteArray {
    if (str.contains('=')) throw IllegalArgumentException("base64url: padding is not allowed")
    val rem = str.length % 4
    if (rem == 1) throw IllegalArgumentException("base64url: invalid length")
    val outLen = (str.length * 3) / 4
    val out = ByteArray(outLen)
    var bits = 0
    var acc = 0
    var pos = 0
    for (ch in str) {
        val code = ch.code
        val v = if (code < 128) B64U_DECODE[code] else -1
        if (v < 0) throw IllegalArgumentException("base64url: invalid character $ch")
        acc = (acc shl 6) or v
        bits += 6
        if (bits >= 8) {
            bits -= 8
            out[pos++] = ((acc ushr bits) and 0xff).toByte()
            acc = acc and ((1 shl bits) - 1)
        }
    }
    if (bits > 0 && (acc and ((1 shl bits) - 1)) != 0) {
        throw IllegalArgumentException("base64url: non-canonical trailing bits")
    }
    return out
}

// Lowercase unpadded Base32 (RFC 4648 §6)
private const val B32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
private val B32_DECODE = IntArray(128) { -1 }.apply {
    for (i in B32_ALPHABET.indices) this[B32_ALPHABET[i].code] = i
}

fun encodeBase32(bytes: ByteArray): String {
    val sb = java.lang.StringBuilder()
    var bits = 0
    var acc = 0
    for (b in bytes) {
        acc = (acc shl 8) or (b.toInt() and 0xff)
        bits += 8
        while (bits >= 5) {
            bits -= 5
            sb.append(B32_ALPHABET[(acc ushr bits) and 31])
        }
        acc = acc and ((1 shl bits) - 1)
    }
    if (bits > 0) {
        sb.append(B32_ALPHABET[(acc shl (5 - bits)) and 31])
    }
    return sb.toString()
}

fun decodeBase32(str: String): ByteArray {
    if (str.contains('=')) throw IllegalArgumentException("base32: padding is not allowed")
    val rem = str.length % 8
    if (rem == 1 || rem == 3 || rem == 6) throw IllegalArgumentException("base32: invalid length")
    val out = ByteArray((str.length * 5) / 8)
    var bits = 0
    var acc = 0
    var pos = 0
    for (ch in str) {
        val code = ch.code
        val v = if (code < 128) B32_DECODE[code] else -1
        if (v < 0) throw IllegalArgumentException("base32: invalid character $ch")
        acc = (acc shl 5) or v
        bits += 5
        if (bits >= 8) {
            bits -= 8
            out[pos++] = ((acc ushr bits) and 0xff).toByte()
            acc = acc and ((1 shl bits) - 1)
        }
    }
    if (bits > 0 && (acc and ((1 shl bits) - 1)) != 0) {
        throw IllegalArgumentException("base32: non-canonical trailing bits")
    }
    return out
}
