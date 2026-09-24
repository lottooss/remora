package io.github.lottooss.remora.core.model

/** Host endpoint id (`h_` + 26 base32 characters, Crypto/1 §2). */
@JvmInline
value class HostId(val value: String) {
    init { require(value.startsWith("h_") && value.length == 28) { "not a host id" } }
}

/** Device endpoint id (`d_` + 26 base32 characters, Crypto/1 §2). */
@JvmInline
value class DeviceId(val value: String) {
    init { require(value.startsWith("d_") && value.length == 28) { "not a device id" } }
}
