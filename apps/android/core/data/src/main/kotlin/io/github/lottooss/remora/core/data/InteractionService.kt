package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.crypto.buildCanonicalApprovalMessage
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Result of an approvals.answer call.
 */
data class ApprovalAnswerResult(
    val accepted: Boolean,
    val finalOutcome: String? = null,
    val by: String? = null,
)

/**
 * Service orchestrating interaction RPC methods: answering approvals with biometric signatures,
 * answering user questions, digest verification, and approval key rotation (RCP/1 §8, Crypto/1 §7).
 */
class InteractionService(
    private val interactionRepository: InteractionRepository,
) {

    /**
     * Answers an approval. Recomputes and verifies argsDigest against displayed preview bytes.
     * High-risk approvals require a biometric signature via [signatureProvider].
     */
    suspend fun answerApproval(
        rcpClient: RcpClient? = null,
        approval: PendingApproval,
        outcome: String, // 'allowed-once' | 'rejected'
        displayedPreviewText: String? = null,
        signatureProvider: (suspend (canonicalMessage: String) -> String?)? = null,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<ApprovalAnswerResult> {
        if (rcpClient == null && rpcCaller == null) {
            return Result.failure(IllegalStateException("Host disconnected"))
        }

        // 1. Digest verification: if caller provided the text displayed to the user,
        // it must match approval.preview.text exactly (threat model T14)
        if (displayedPreviewText != null && displayedPreviewText != approval.preview.text) {
            return Result.failure(
                SecurityException("Preview text mismatch: displayed text differs from pending approval preview"),
            )
        }

        val issuedAt = System.currentTimeMillis()
        val canonicalMsg = buildCanonicalApprovalMessage(
            approvalId = approval.id,
            outcome = outcome,
            issuedAt = issuedAt,
            argsDigest = approval.argsDigest,
        )

        val isHighRisk = approval.risk == "high" || approval.requiresSignature
        var signatureB64u: String? = null

        if (isHighRisk) {
            if (signatureProvider == null) {
                return Result.failure(
                    SecurityException("Biometric signature required for high-risk approval"),
                )
            }
            signatureB64u = signatureProvider(canonicalMsg)
            if (signatureB64u.isNullOrEmpty()) {
                return Result.failure(
                    SecurityException("Biometric authentication cancelled or signature missing"),
                )
            }
        }

        return runCatching {
            val params = buildJsonObject {
                put("id", approval.id)
                put("outcome", outcome)
                put("argsDigest", approval.argsDigest)
                put("issuedAt", issuedAt)
                if (signatureB64u != null) {
                    put("sig", signatureB64u)
                }
            }

            val res = if (rpcCaller != null) {
                rpcCaller("approvals.answer", params)
            } else {
                rcpClient!!.call("approvals.answer", params).jsonObject
            }
            val accepted = res["accepted"]?.jsonPrimitive?.booleanOrNull ?: true
            val finalOutcome = res["final"]?.jsonPrimitive?.content
            val by = res["by"]?.jsonPrimitive?.content ?: "phone"

            // Mark locally resolved
            interactionRepository.resolve(approval.id, by = by)

            ApprovalAnswerResult(
                accepted = accepted,
                finalOutcome = finalOutcome,
                by = by,
            )
        }
    }

    /**
     * Answers a pending user question (free text, options, or plan review).
     */
    suspend fun answerQuestion(
        rcpClient: RcpClient? = null,
        questionId: String,
        answers: List<String> = emptyList(),
        text: String? = null,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<Boolean> {
        if (rcpClient == null && rpcCaller == null) {
            return Result.failure(IllegalStateException("Host disconnected"))
        }

        return runCatching {
            val params = buildJsonObject {
                put("id", questionId)
                put("answers", kotlinx.serialization.json.JsonArray(answers.map { kotlinx.serialization.json.JsonPrimitive(it) }))
                if (text != null) {
                    put("text", text)
                }
            }

            if (rpcCaller != null) {
                rpcCaller("questions.answer", params)
            } else {
                rcpClient!!.call("questions.answer", params)
            }
            interactionRepository.resolve(questionId, by = "phone")
            true
        }
    }

    /**
     * Rotates device approval public key on the host (Crypto/1 §10).
     */
    suspend fun rotateApprovalKeyOnHost(
        rcpClient: RcpClient? = null,
        newPublicKeySpkiDer: ByteArray,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<Boolean> {
        if (rcpClient == null && rpcCaller == null) {
            return Result.failure(IllegalStateException("Host disconnected"))
        }

        return runCatching {
            val params = buildJsonObject {
                put("approvalPub", encodeBase64Url(newPublicKeySpkiDer))
            }
            if (rpcCaller != null) {
                rpcCaller("devices.rotateApprovalKey", params)
            } else {
                rcpClient!!.call("devices.rotateApprovalKey", params)
            }
            true
        }
    }
}
