package io.github.lottooss.remora.spike.approvalkey

import java.security.MessageDigest

/** Wire outcome of a signed approval (Crypto/1 §7). */
enum class ApprovalOutcome(val wire: String) {
    ALLOWED_ONCE("allowed-once"),
    REJECTED("rejected"),
    ;

    companion object {
        fun fromWire(value: String): ApprovalOutcome =
            entries.firstOrNull { it.wire == value }
                ?: throw IllegalArgumentException("unknown outcome: $value")
    }
}

/**
 * Canonical approval message (Crypto/1 §7): exactly 10 UTF-8 lines joined by
 * `\n` with no trailing newline. Every field is attacker-visible on the wire
 * once signed, but a newline inside a field would change the line structure,
 * so it is rejected at construction.
 */
data class ApprovalMessage(
    val hostId: String,
    val deviceId: String,
    val approvalId: String,
    val sessionId: String,
    val callId: String?,
    val toolName: String,
    val argsDigest: String,
    val outcome: ApprovalOutcome,
    val issuedAt: Long,
) {
    init {
        for ((name, value) in mapOf(
            "hostId" to hostId,
            "deviceId" to deviceId,
            "approvalId" to approvalId,
            "sessionId" to sessionId,
            "toolName" to toolName,
        )) {
            require(value.isNotEmpty()) { "$name must not be empty" }
            require(!value.contains('\n') && !value.contains('\r')) { "$name must not contain newlines" }
        }
        if (callId != null) {
            require(callId.isNotEmpty()) { "callId must be null or non-empty (use null for \"-\")" }
            require(!callId.contains('\n') && !callId.contains('\r')) { "callId must not contain newlines" }
        }
        require(HEX_64.matches(argsDigest)) { "argsDigest must be 64 lowercase hex chars" }
        require(issuedAt >= 0) { "issuedAt must be non-negative" }
    }

    /** Serializes to the exact bytes that [android.security.keystore] signs. */
    fun canonical(): String = listOf(
        HEADER,
        hostId,
        deviceId,
        approvalId,
        sessionId,
        callId ?: "-",
        toolName,
        argsDigest,
        outcome.wire,
        issuedAt.toString(),
    ).joinToString("\n")

    companion object {
        const val HEADER = "remora/1 approval"
        private val HEX_64 = Regex("[0-9a-f]{64}")
    }
}

/**
 * `argsDigest = hex_lower(SHA-256(UTF-8(previewText) ‖ 0x00 ‖ UTF-8(previewJson)))`
 * (Crypto/1 §7). The phone MUST recompute this from the bytes it displays and
 * refuse to sign on mismatch.
 */
fun computeArgsDigest(previewText: String, previewJson: String): String {
    val md = MessageDigest.getInstance("SHA-256")
    md.update(previewText.toByteArray(Charsets.UTF_8))
    md.update(0x00)
    md.update(previewJson.toByteArray(Charsets.UTF_8))
    return md.digest().joinToString("") { "%02x".format(it) }
}
