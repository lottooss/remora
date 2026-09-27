package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Service coordinating RPC session methods: listing, searching, idempotent prompt sending with retries,
 * model selection, paging, and cancellation. Enforces fail-closed offline policy.
 */
class SessionService(
    private val sessionRepository: SessionRepository,
) {

    suspend fun listSessions(rcpClient: RcpClient?, limit: Int = 50): Result<List<SessionSummary>> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Host disconnected"))
        return runCatching {
            val params = buildJsonObject {
                put("limit", limit)
            }
            val res = client.call("sessions.list", params).jsonObject
            val itemsArr = res["items"]?.jsonArray ?: throw IllegalStateException("Missing items in sessions.list response")
            val sessions = itemsArr.mapNotNull {
                if (it is JsonObject) SessionCodecs.parseSessionSummary(it) else null
            }
            sessionRepository.setSessions(sessions)
            sessions
        }
    }

    suspend fun searchSessions(rcpClient: RcpClient?, query: String): Result<List<SearchResult>> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Host disconnected"))
        return runCatching {
            val params = buildJsonObject {
                put("query", query)
            }
            val res = client.call("sessions.search", params).jsonObject
            val resultsArr = res["results"]?.jsonArray ?: emptyList()
            resultsArr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val sId = elem["sessionId"]?.jsonPrimitive?.content ?: return@mapNotNull null
                    val title = elem["title"]?.jsonPrimitive?.content
                    val snippet = elem["snippet"]?.jsonPrimitive?.content ?: ""
                    val at = elem["at"]?.jsonPrimitive?.longOrNull ?: 0L
                    SearchResult(sessionId = sId, title = title, snippet = snippet, at = at)
                } else null
            }
        }
    }

    /**
     * Sends a prompt with exactly-once idempotency semantics (Cardinal Invariant 7).
     * Retries use the SAME requestId so the host deduplicates without running twice.
     */
    suspend fun sendPrompt(
        rcpClient: RcpClient?,
        sessionId: String,
        text: String,
        delivery: String = "queue", // 'queue' | 'steer'
        maxAttempts: Int = 2,
    ): Result<Boolean> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Cannot mutate session while disconnected"))
        val requestId = UUID.randomUUID().toString()

        var lastError: Throwable? = null
        for (attempt in 1..maxAttempts) {
            try {
                val params = buildJsonObject {
                    put("sessionId", sessionId)
                    put("requestId", requestId)
                    put("text", text)
                    put("delivery", delivery)
                }
                val res = client.call("sessions.prompt", params, timeoutMs = 8_000).jsonObject
                val accepted = res["accepted"]?.jsonPrimitive?.booleanOrNull ?: false
                return Result.success(accepted)
            } catch (t: Throwable) {
                lastError = t
                // Timeout or transient network error: loop and retry with the SAME requestId
            }
        }
        return Result.failure(lastError ?: IllegalStateException("Prompt send failed"))
    }

    suspend fun cancelTurn(
        rcpClient: RcpClient?,
        sessionId: String,
    ): Result<Boolean> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Cannot mutate session while disconnected"))
        val requestId = UUID.randomUUID().toString()
        return runCatching {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("requestId", requestId)
            }
            val res = client.call("sessions.cancel", params).jsonObject
            res["requested"]?.jsonPrimitive?.booleanOrNull ?: false
        }
    }

    suspend fun loadOlderEvents(
        rcpClient: RcpClient?,
        sessionId: String,
        limit: Int = 50,
    ): Result<Boolean> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Host disconnected"))
        val lowestSeq = sessionRepository.getLowestSeq(sessionId)
        if (lowestSeq <= 1L) {
            sessionRepository.setHasOlder(sessionId, false)
            return Result.success(false)
        }

        return runCatching {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("beforeSeq", lowestSeq)
                put("limit", limit)
            }
            val res = client.call("sessions.page", params).jsonObject
            val eventsArr = res["events"]?.jsonArray ?: emptyList()
            val events = eventsArr.mapNotNull {
                if (it is JsonObject) SessionCodecs.parseSessionEvent(it) else null
            }
            val hasOlder = res["hasOlder"]?.jsonPrimitive?.booleanOrNull ?: false
            sessionRepository.prependOlderEvents(sessionId, events, hasOlder)
            hasOlder
        }
    }

    suspend fun loadModelsCatalog(rcpClient: RcpClient?): Result<List<ModelRef>> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Host disconnected"))
        return runCatching {
            val res = client.call("models.catalog", buildJsonObject {}).jsonObject
            val providersArr = res["providers"]?.jsonArray ?: emptyList()
            val list = mutableListOf<ModelRef>()
            providersArr.forEach { pElem ->
                if (pElem is JsonObject) {
                    val pId = pElem["id"]?.jsonPrimitive?.content ?: ""
                    val modelsArr = pElem["models"]?.jsonArray ?: emptyList()
                    modelsArr.forEach { mElem ->
                        if (mElem is JsonObject) {
                            val mId = mElem["id"]?.jsonPrimitive?.content ?: ""
                            list.add(ModelRef(provider = pId, model = mId))
                        }
                    }
                }
            }
            list
        }
    }

    suspend fun selectModel(
        rcpClient: RcpClient?,
        sessionId: String,
        model: ModelRef,
    ): Result<ModelRef> {
        val client = rcpClient ?: return Result.failure(IllegalStateException("Cannot mutate session while disconnected"))
        val requestId = UUID.randomUUID().toString()
        return runCatching {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("requestId", requestId)
                put("model", buildJsonObject {
                    put("provider", model.provider)
                    put("model", model.model)
                    if (model.reasoningEffort != null) {
                        put("reasoningEffort", model.reasoningEffort)
                    }
                })
            }
            val res = client.call("sessions.selectModel", params).jsonObject
            val mObj = res["model"]?.jsonObject ?: throw IllegalStateException("Missing model in selectModel response")
            SessionCodecs.parseModelRef(mObj) ?: model
        }
    }
}
