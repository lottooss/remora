package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.crypto.buildCanonicalApprovalMessage
import io.github.lottooss.remora.core.crypto.computeArgsDigest
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.security.MessageDigest
import java.util.UUID

/** A complete, validated approvals.answer response. */
data class ApprovalAnswerResult(val accepted: Boolean, val finalOutcome: String, val by: String)

/**
 * Answers pending interactions belonging to one host and repository. Callers must
 * route [RcpClient] or their RPC callback to that same authenticated host connection.
 */
class InteractionService(
    private val interactionRepository: InteractionRepository,
    private val hostId: String,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val answerMutex = Mutex()

    /** Checks displayed bytes and current pending state before invoking biometric signing. */
    suspend fun answerApproval(
        hostId: String,
        approval: PendingApproval,
        outcome: String,
        displayedPreview: ApprovalPreview,
        rcpClient: RcpClient? = null,
        signatureProvider: (suspend (canonicalMessage: String) -> String?)? = null,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<ApprovalAnswerResult> = answer {
        requireHost(hostId)
        requireCaller(rcpClient, rpcCaller)
        requirePending(PendingInteraction.Approval(approval))
        checkSecurity(outcome == "allowed-once" || outcome == "rejected", "Invalid approval outcome")
        checkSecurity(approval.risk == "normal" || approval.risk == "high", "Unknown approval risk")
        checkSecurity(displayedPreview == approval.preview, "Displayed approval preview changed")
        val digest = computeArgsDigest(displayedPreview.text, displayedPreview.json)
        checkSecurity(
            MessageDigest.isEqual(digest.toByteArray(Charsets.UTF_8), approval.argsDigest.toByteArray(Charsets.UTF_8)),
            "Approval preview digest mismatch",
        )
        val issuedAt = nowMillis()
        val canonicalMessage = buildCanonicalApprovalMessage(approval.id, outcome, issuedAt, digest)
        val signature = if (approval.requiresSignature || approval.risk == "high") {
            val provider = signatureProvider ?: throw SecurityException("Biometric signature required")
            val encoded = provider(canonicalMessage)
                ?: throw SecurityException("Biometric authentication cancelled")
            checkSecurity(Regex("^[A-Za-z0-9_-]+$").matches(encoded), "Invalid approval signature encoding")
            val signatureBytes = decodeBase64Url(encoded)
            checkSecurity(signatureBytes.isNotEmpty() && encodeBase64Url(signatureBytes) == encoded, "Invalid approval signature encoding")
            encoded
        } else null

        // The user may have spent time in BiometricPrompt while PC resolution or expiry occurred.
        requireHost(hostId)
        requirePending(PendingInteraction.Approval(approval))
        checkSecurity(nowMillis() - issuedAt in 0L..300_000L, "Approval authentication expired")
        val params = buildJsonObject {
            put("id", approval.id)
            put("outcome", outcome)
            put("argsDigest", digest)
            put("issuedAt", issuedAt)
            if (signature != null) put("sig", signature)
        }
        val response = call("approvals.answer", params, rcpClient, rpcCaller)
        val accepted = response.requiredBoolean("accepted")
        val finalOutcome = response.requiredString("final")
        val by = response.resolvedBy()
        checkSecurity(finalOutcome in setOf("allowed-once", "rejected", "cancelled", "unavailable"), "Invalid approval response")
        checkSecurity(!accepted || (finalOutcome == outcome && by == "phone"), "Inconsistent approval response")
        resolveIfUnchanged(PendingInteraction.Approval(approval), by)
        ApprovalAnswerResult(accepted, finalOutcome, by)
    }

    /** Sends the complete structured answers to the displayed pending question batch. */
    suspend fun answerQuestion(
        hostId: String,
        question: PendingQuestion,
        answers: List<QuestionAnswer>,
        rcpClient: RcpClient? = null,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<Boolean> = answer {
        requireHost(hostId)
        requireCaller(rcpClient, rpcCaller)
        requirePending(PendingInteraction.Question(question))
        val prompts = question.questions.associateBy { it.id }
        checkSecurity(prompts.size == question.questions.size && prompts.isNotEmpty(), "Invalid pending questions")
        checkSecurity(answers.size == prompts.size && answers.map { it.id }.toSet() == prompts.keys, "Incomplete question answers")
        for (answer in answers) {
            val prompt = prompts[answer.id] ?: throw SecurityException("Unknown question answer")
            checkSecurity(answer.selected.distinct().size == answer.selected.size, "Duplicate question selection")
            checkSecurity(prompt.multiSelect || answer.selected.size <= 1, "Too many question selections")
            checkSecurity(answer.selected.all { selected -> prompt.options.any { it.label == selected } }, "Unknown question selection")
            checkSecurity(answer.selected.isNotEmpty() || !answer.custom.isNullOrBlank(), "Empty question answer")
        }
        val params = buildJsonObject {
            put("id", question.id)
            put("answers", JsonArray(answers.map { answer ->
                buildJsonObject {
                    put("id", answer.id)
                    put("selected", JsonArray(answer.selected.map(::JsonPrimitive)))
                    if (answer.custom != null) put("custom", answer.custom)
                }
            }))
        }
        val response = call("questions.answer", params, rcpClient, rpcCaller)
        val accepted = response.requiredBoolean("accepted")
        val by = response.resolvedBy()
        checkSecurity(!accepted || by == "phone", "Inconsistent question response")
        resolveIfUnchanged(PendingInteraction.Question(question), by)
        accepted
    }

    /** Requests key rotation. Success means pending PC confirmation, never immediate activation. */
    suspend fun rotateApprovalKeyOnHost(
        hostId: String,
        newPublicKeySpkiDer: ByteArray,
        requestId: String = UUID.randomUUID().toString(),
        rcpClient: RcpClient? = null,
        rpcCaller: (suspend (method: String, params: JsonObject) -> JsonObject)? = null,
    ): Result<Boolean> = result {
        requireHost(hostId)
        requireCaller(rcpClient, rpcCaller)
        checkSecurity(newPublicKeySpkiDer.isNotEmpty(), "Missing approval public key")
        checkSecurity(
            Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").matches(requestId),
            "Invalid key rotation request id",
        )
        val response = call("devices.rotateApprovalKey", buildJsonObject {
            put("approvalPub", encodeBase64Url(newPublicKeySpkiDer))
            put("requestId", requestId)
        }, rcpClient, rpcCaller)
        checkSecurity(response.requiredString("status") == "pending_pc_confirmation", "Invalid key rotation response")
        true
    }

    private fun requireHost(selectedHostId: String) {
        checkSecurity(hostId.isNotBlank() && hostId == selectedHostId, "Interaction host changed")
    }

    private fun requirePending(pending: PendingInteraction) {
        checkSecurity(interactionRepository.allPending.value.any { it == pending }, "Interaction is no longer pending")
        checkSecurity(nowMillis() < pending.expiresAt, "Interaction expired")
    }

    private fun resolveIfUnchanged(pending: PendingInteraction, by: String) {
        if (interactionRepository.allPending.value.any { it == pending }) interactionRepository.resolve(pending.id, by)
    }

    private fun requireCaller(client: RcpClient?, caller: (suspend (String, JsonObject) -> JsonObject)?) {
        check(client != null || caller != null) { "Host disconnected" }
    }

    private suspend fun call(
        method: String,
        params: JsonObject,
        client: RcpClient?,
        caller: (suspend (String, JsonObject) -> JsonObject)?,
    ): JsonObject = if (caller != null) caller(method, params) else {
        val response = checkNotNull(client) { "Host disconnected" }.call(method, params)
        response as? JsonObject ?: throw SecurityException("Invalid interaction response")
    }

    private fun JsonObject.requiredString(key: String): String {
        val value = this[key] as? JsonPrimitive ?: throw SecurityException("Incomplete interaction response")
        checkSecurity(value.isString, "Invalid interaction response")
        return value.content
    }

    private fun JsonObject.requiredBoolean(key: String): Boolean {
        val value = this[key] as? JsonPrimitive ?: throw SecurityException("Incomplete interaction response")
        checkSecurity(!value.isString, "Invalid interaction response")
        return value.booleanOrNull ?: throw SecurityException("Invalid interaction response")
    }

    private fun JsonObject.resolvedBy(): String = requiredString("by").also {
        checkSecurity(it in setOf("phone", "pc", "system"), "Invalid interaction resolver")
    }

    private fun checkSecurity(condition: Boolean, message: String) {
        if (!condition) throw SecurityException(message)
    }

    private suspend fun <T> answer(block: suspend () -> T): Result<T> {
        if (!answerMutex.tryLock()) return Result.failure(IllegalStateException("An interaction answer is in progress"))
        return try { result(block) } finally { answerMutex.unlock() }
    }

    private suspend fun <T> result(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Exception) {
        Result.failure(error)
    }
}
