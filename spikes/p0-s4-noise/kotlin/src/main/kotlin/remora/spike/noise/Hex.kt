package remora.spike.noise

private val HEX_CHARS = "0123456789abcdef".toCharArray()

/** Strict lowercase hex → bytes; rejects odd length and uppercase (same contract as the TS decodeHex). */
fun hexToBytes(hex: String): ByteArray {
    require(hex.length % 2 == 0) { "hex string must have even length" }
    require(hex.all { it in '0'..'9' || it in 'a'..'f' }) { "hex string must be lowercase" }
    return ByteArray(hex.length / 2) { i ->
        val hi = Character.digit(hex[i * 2], 16)
        val lo = Character.digit(hex[i * 2 + 1], 16)
        ((hi shl 4) or lo).toByte()
    }
}

fun bytesToHex(bytes: ByteArray): String {
    val out = CharArray(bytes.size * 2)
    bytes.forEachIndexed { i, b ->
        val v = b.toInt() and 0xff
        out[i * 2] = HEX_CHARS[v shr 4]
        out[i * 2 + 1] = HEX_CHARS[v and 0x0f]
    }
    return String(out)
}
