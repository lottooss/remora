package io.github.lottooss.remora.core.crypto

/** Builds the existing five-line TS approval message, rejecting ambiguous inputs. */
fun buildCanonicalApprovalMessage(
    approvalId: String,
    outcome: String,
    issuedAt: Long,
    argsDigest: String,
): String {
    require(approvalId.isNotEmpty() && approvalId.length <= 128 && '\r' !in approvalId && '\n' !in approvalId) {
        "Approval id is malformed"
    }
    require(outcome == "allowed-once" || outcome == "rejected") { "Approval outcome is invalid" }
    require(issuedAt in 0L..9_007_199_254_740_991L) { "Approval timestamp is invalid" }
    require(Regex("^(sha256:)?[0-9a-f]{64}$").matches(argsDigest)) { "Approval digest is malformed" }
    return "remora/1 approval\n$approvalId\n$argsDigest\n$outcome\n$issuedAt"
}

/**
 * Matches TS computeArgsDigest({text, json}): SHA-256 of the canonical JSON object.
 * [previewJson] is a raw JSON string and is not parsed or normalized. This retains
 * the currently deployed TS format; Crypto/1's conflicting body needs a coordinated decision.
 */
fun computeArgsDigest(previewText: String, previewJson: String): String {
    val canonical = "{\"json\":" + quoteJsonString(previewJson) + ",\"text\":" + quoteJsonString(previewText) + "}"
    val input = canonical.toByteArray(Charsets.UTF_8)
    return "sha256:" + encodeHex(sha256(input))
}

// JSON.stringify string encoding, including well-formed escaping of lone UTF-16 surrogates.
// The preview object has only string values, so general JCS number serialization is unnecessary.
private fun quoteJsonString(value: String): String = buildString {
    append('"')
    var index = 0
    while (index < value.length) {
        val char = value[index]
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '\b' -> append("\\b")
            '\u000c' -> append("\\f")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> when {
                char.isHighSurrogate() && index + 1 < value.length && value[index + 1].isLowSurrogate() -> {
                    append(char)
                    append(value[++index])
                }
                char.code < 0x20 || char.isSurrogate() -> {
                    append("\\u")
                    append(char.code.toString(16).padStart(4, '0'))
                }
                else -> append(char)
            }
        }
        index += 1
    }
    append('"')
}
