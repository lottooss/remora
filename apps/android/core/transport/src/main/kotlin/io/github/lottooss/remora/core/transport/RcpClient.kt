package io.github.lottooss.remora.core.transport

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

class RcpClientException(
    val code: String,
    message: String,
    val details: JsonElement? = null,
) : RuntimeException("RCP Error [$code]: $message")

/**
 * RCP/1 client (docs/specs/rcp-v1.md §2–§4) implementing unary calls,
 * stream multiplexing, timeouts, and cancellation over a SecureChannel.
 */
class RcpClient(
    private val channel: SecureChannel,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + Job()),
) {

    private val json = Json { ignoreUnknownKeys = true }
    private val nextRequestId = AtomicLong(1L)
    private val pendingCalls = ConcurrentHashMap<Long, CompletableDeferred<JsonElement>>()

    private val activeStreams = ConcurrentHashMap<Long, MutableSharedFlow<JsonElement>>()
    private var listenerJob: Job? = null

    init {
        listenerJob = scope.launch {
            channel.incomingMessages.collect { messageJson ->
                handleIncomingMessage(messageJson)
            }
        }
    }

    suspend fun call(
        method: String,
        params: JsonElement? = null,
        timeoutMs: Long = 10_000,
    ): JsonElement {
        val id = nextRequestId.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        pendingCalls[id] = deferred

        val requestObj = buildJsonObject {
            put("k", "req")
            put("id", id)
            put("m", method)
            if (params != null) {
                put("p", params)
            } else {
                put("p", buildJsonObject {})
            }
        }

        channel.sendTransport(requestObj.toString())

        return try {
            withTimeout(timeoutMs) {
                deferred.await()
            }
        } finally {
            pendingCalls.remove(id)
        }
    }

    fun openStream(method: String, params: JsonElement? = null): Flow<JsonElement> {
        val flow = MutableSharedFlow<JsonElement>(
            extraBufferCapacity = 128,
            onBufferOverflow = BufferOverflow.DROP_OLDEST,
        )

        scope.launch {
            try {
                val res = call(method, params)
                val sid = res.jsonObject["sid"]?.jsonPrimitive?.longOrNull
                    ?: throw RcpClientException("invalid_response", "Stream open did not return sid")

                activeStreams[sid] = flow
            } catch (e: Exception) {
                // If stream open failed, we can complete or throw in caller
            }
        }

        return flow.asSharedFlow()
    }

    suspend fun cancelStream(sid: Long) {
        activeStreams.remove(sid)
        val cancelObj = buildJsonObject {
            put("k", "cancel")
            put("sid", sid)
        }
        channel.sendTransport(cancelObj.toString())
    }

    fun close() {
        listenerJob?.cancel()
        val ex = RcpClientException("channel_closed", "RCP Client closed")
        pendingCalls.values.forEach { it.completeExceptionally(ex) }
        pendingCalls.clear()
        activeStreams.clear()
    }

    private fun handleIncomingMessage(text: String) {
        try {
            val root = json.parseToJsonElement(text).jsonObject
            val kind = root["k"]?.jsonPrimitive?.content

            when (kind) {
                "res" -> {
                    val id = root["id"]?.jsonPrimitive?.longOrNull ?: return
                    val deferred = pendingCalls[id] ?: return
                    val ok = root["ok"]?.jsonPrimitive?.booleanOrNull ?: false
                    if (ok) {
                        val result = root["r"] ?: buildJsonObject {}
                        deferred.complete(result)
                    } else {
                        val errObj = root["e"]?.jsonObject
                        val code = errObj?.get("code")?.jsonPrimitive?.content ?: "internal_error"
                        val msg = errObj?.get("message")?.jsonPrimitive?.content ?: "RCP call failed"
                        val details = errObj?.get("details")
                        deferred.completeExceptionally(RcpClientException(code, msg, details))
                    }
                }

                "item" -> {
                    val sid = root["sid"]?.jsonPrimitive?.longOrNull ?: return
                    val data = root["d"] ?: return
                    activeStreams[sid]?.tryEmit(data)
                }

                "end" -> {
                    val sid = root["sid"]?.jsonPrimitive?.longOrNull ?: return
                    activeStreams.remove(sid)
                }
            }
        } catch (_: Exception) {}
    }
}
