package io.github.lottooss.remora.core.crypto

fun buildCanonicalApprovalMessage(
    approvalId: String,
    outcome: String,
    issuedAt: Long,
    argsDigest: String,
): String {
    return "remora/1 approval\n$approvalId\n$argsDigest\n$outcome\n$issuedAt"
}

fun computeArgsDigest(method: String, argsJson: String): String {
    val input = "remora/1 args\n$method\n$argsJson".toByteArray(Charsets.UTF_8)
    return "sha256:" + encodeHex(sha256(input))
}
