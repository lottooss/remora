package io.github.lottooss.remora.core.crypto

import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Canonical endpoint identity required before cryptographic context binding. */
internal fun requireEndpointId(id: String, kind: String) {
    val prefix = if (kind == "host") "h_" else "d_"
    require(id.startsWith(prefix) && id.length == 28 && decodeBase32(id.substring(2)).size == 16) { "Malformed endpoint id" }
}

/** Exact canonical HTTP(S) origin; production callers enforce their TLS policy. */
internal fun requireRelayOrigin(origin: String) {
    val uri = URI(origin)
    require(!uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null &&
        uri.rawFragment == null && uri.rawPath.isNullOrEmpty() &&
        (uri.port == -1 || uri.port in 1..65535)) { "Malformed relay origin" }
    require(uri.host == uri.host.lowercase() && uri.scheme in setOf("https", "http")) { "Non-canonical relay origin" }
    require(!(uri.scheme == "https" && uri.port == 443) && !(uri.scheme == "http" && uri.port == 80)) { "Non-canonical relay port" }
    require(uri.scheme == "https" || uri.host in setOf("127.0.0.1", "10.0.2.2")) { "Relay must use https" }
}

/** Decode cryptographic plaintext without silently replacing malformed UTF-8. */
internal fun strictUtf8(bytes: ByteArray): String = Charsets.UTF_8.newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
    .decode(ByteBuffer.wrap(bytes)).toString()

/** Reject unpaired UTF-16 surrogates rather than hash platform-specific replacement bytes. */
internal fun requireUnicode(value: String) {
    var index = 0
    while (index < value.length) {
        val ch = value[index++]
        if (ch.isHighSurrogate()) require(index < value.length && value[index++].isLowSurrogate()) { "Malformed Unicode" }
        else require(!ch.isLowSurrogate()) { "Malformed Unicode" }
    }
}
