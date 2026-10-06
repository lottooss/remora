package io.github.lottooss.remora.core.crypto

/** Complete authenticated pending context used by Crypto/1 §7. */
data class ApprovalMessageFields(
    val hostId: String,
    val deviceId: String,
    val approvalId: String,
    val sessionId: String,
    val callId: String? = null,
    val toolName: String,
    val argsDigest: String,
    val outcome: String,
    val issuedAt: Long,
)

/** Ten UTF-8 lines with no trailing newline; no legacy signing fallback. */
fun buildCanonicalApprovalMessage(fields: ApprovalMessageFields): String = with(fields) {
    requireEndpointId(hostId, "host")
    requireEndpointId(deviceId, "device")
    for (value in listOfNotNull(approvalId, sessionId, callId, toolName)) {
        require(value.isNotEmpty() && value.length <= 1024 && value.none { it == '\r' || it == '\n' || it == '\u0000' }) { "Malformed approval context" }
        requireUnicode(value)
    }
    require(approvalId.length <= 128 && callId != "-") { "Malformed approval id or call id" }
    require(outcome == "allowed-once" || outcome == "rejected") { "Approval outcome is invalid" }
    require(issuedAt in 0L..9_007_199_254_740_991L) { "Approval timestamp is invalid" }
    require(Regex("^[0-9a-f]{64}$").matches(argsDigest)) { "Approval digest is malformed" }
    listOf("remora/1 approval", hostId, deviceId, approvalId, sessionId, callId ?: "-", toolName, argsDigest, outcome, issuedAt.toString()).joinToString("\n")
}

/** Hashes the exact displayed text, a NUL separator and raw JSON string (Crypto/1 §7). */
fun computeArgsDigest(previewText: String, previewJson: String): String {
    requireUnicode(previewText)
    requireUnicode(previewJson)
    return encodeHex(sha256(previewText.toByteArray(Charsets.UTF_8) + byteArrayOf(0) + previewJson.toByteArray(Charsets.UTF_8)))
}
