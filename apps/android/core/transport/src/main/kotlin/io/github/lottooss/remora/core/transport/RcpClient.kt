package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.protocol.RcpPayloads
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

class RcpClientException(val code: String, message: String, val details: JsonElement? = null) :
    RuntimeException("RCP error [$code]: $message")

/** RCP requests and lossless bounded streams. A collector owns and cancels its remote stream. */
class RcpClient(
    private val channel: SecureChannel,
    scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
) {
    private data class Stream(val method: String, val items: Channel<JsonElement>, var sequence: Long = 0)
    private data class Pending(val method: String, val result: CompletableDeferred<JsonElement>, val stream: Stream? = null)
    private val job = SupervisorJob(scope.coroutineContext[Job])
    private val clientScope = CoroutineScope(scope.coroutineContext + job)
    private val nextId = AtomicLong(1)
    private val pending = ConcurrentHashMap<Long, Pending>()
    private val streams = ConcurrentHashMap<Long, Stream>()
    private val earlyFrames = ConcurrentHashMap<Long, MutableList<JsonObject>>()
    private val closed = AtomicBoolean(false)

    init {
        clientScope.launch(start = CoroutineStart.UNDISPATCHED) {
            channel.incomingMessages.collect { handle(it) }
        }
        clientScope.launch { channel.closed.await(); close() }
    }

    suspend fun call(method: String, params: JsonElement? = null, timeoutMs: Long = 30_000): JsonElement =
        request(method, params, timeoutMs)

    private suspend fun request(method: String, params: JsonElement?, timeoutMs: Long, stream: Stream? = null): JsonElement {
        check(!closed.get()) { "RCP channel closed" }
        val rawParams = params ?: buildJsonObject {}
        val checkedParams = if (RcpPayloads.metadata(method) != null) RcpPayloads.params(method, rawParams) else rawParams
        check(pending.size < 64) { "Too many pending requests" }
        val id = nextId.getAndUpdate { if (it >= 0xffffffffL) 1 else it + 1 }
        val item = Pending(method, CompletableDeferred(), stream)
        check(pending.putIfAbsent(id, item) == null) { "Request id collision" }
        try {
            channel.sendTransport(buildJsonObject {
                put("k", "req"); put("id", id); put("m", method)
                put("p", checkedParams)
            }.toString())
            return withTimeout(timeoutMs) { item.result.await() }
        } finally { pending.remove(id) }
    }

    fun openStream(method: String, params: JsonElement? = null): Flow<JsonElement> = flow {
        check(streams.size < 10) { "Too many open streams" }
        val stream = Stream(method, Channel(128))
        var sid: Long? = null
        try {
            sid = request(method, params, 30_000, stream).jsonObject["sid"]?.jsonPrimitive?.longOrNull
                ?: throw RcpClientException("bad_response", "Missing stream id")
            for (item in stream.items) emit(item)
        } finally {
            // A response may have registered the stream just before this collector was cancelled.
            val registered = sid ?: streams.entries.firstOrNull { it.value === stream }?.key
            if (registered != null) withContext(NonCancellable) {
                withTimeoutOrNull(1_000) { runCatching { cancelStream(registered) } }
            }
            if (registered == null) channel.close()
            stream.items.cancel()
        }
    }

    suspend fun cancelStream(sid: Long) {
        streams.remove(sid)?.items?.close()
        if (!closed.get()) channel.sendTransport(buildJsonObject { put("k", "cancel"); put("sid", sid) }.toString())
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        val error = RcpClientException("channel_closed", "Connection closed")
        pending.values.forEach { it.result.completeExceptionally(error); it.stream?.items?.close(error) }
        pending.clear()
        streams.values.forEach { it.items.close(error) }
        streams.clear(); earlyFrames.clear()
        job.cancel()
    }

    private fun handle(text: String) {
        try {
            val root = RcpPayloads.envelope(Json.parseToJsonElement(text))
            when (root["k"]?.jsonPrimitive?.content) {
                "res" -> {
                    val id = root["id"]?.jsonPrimitive?.longOrNull ?: error("Missing request id")
                    val p = pending[id] ?: return
                    if (root["ok"]?.jsonPrimitive?.booleanOrNull == true) {
                        val rawResult = root["r"] ?: buildJsonObject {}
                        val result = if (RcpPayloads.metadata(p.method) != null) RcpPayloads.result(p.method, rawResult) else rawResult
                        if (p.stream != null) {
                            val sid = result.jsonObject["sid"]?.jsonPrimitive?.longOrNull ?: error("Missing stream id")
                            require(sid in 0..0xffffffffL && streams.putIfAbsent(sid, p.stream) == null)
                            earlyFrames.remove(sid)?.forEach { handle(it.toString()) }
                        }
                        // Register before waking the caller: the next frame can already be a baseline.
                        p.result.complete(result)
                    } else {
                        p.result.completeExceptionally(wireError(root["e"]))
                    }
                }
                "item" -> {
                    val sid = root["sid"]?.jsonPrimitive?.longOrNull ?: error("Missing stream id")
                    val stream = streams[sid] ?: run { bufferEarly(sid, root); return }
                    val sequence = root["n"]?.jsonPrimitive?.longOrNull ?: error("Missing stream sequence")
                    require(sequence == stream.sequence++)
                    val rawItem = root["d"] ?: error("Missing stream data")
                    val item = if (RcpPayloads.metadata(stream.method) != null) RcpPayloads.item(stream.method, rawItem) else rawItem
                    if (!stream.items.trySend(item).isSuccess) {
                        // Losing a durable event is unsafe; reconnect and resume from the durable cursor.
                        channel.close()
                    }
                }
                "end" -> {
                    val sid = root["sid"]?.jsonPrimitive?.longOrNull ?: error("Missing stream id")
                    val stream = streams.remove(sid) ?: run { bufferEarly(sid, root); return }
                    stream.items.close(
                        if (root["ok"]?.jsonPrimitive?.booleanOrNull == true) null else wireError(root["e"]),
                    )
                }
                "evt" -> if (root["e"]?.jsonPrimitive?.content == "host.shutdown") channel.close()
            }
        } catch (_: Exception) { channel.close() }
    }

    private fun bufferEarly(sid: Long, frame: JsonObject) {
        // Current hosts may send their baseline while the stream-open handler is still returning.
        if (pending.values.none { it.stream != null }) return
        require(earlyFrames.size < 10 || earlyFrames.containsKey(sid))
        require(earlyFrames.values.sumOf { it.size } < 128)
        earlyFrames.computeIfAbsent(sid) { mutableListOf() }.add(frame)
    }

    private fun wireError(element: JsonElement?): RcpClientException {
        val obj = element as? JsonObject
        val code = obj?.get("code")?.jsonPrimitive?.content?.takeIf { it.matches(Regex("[a-z_]{1,40}")) } ?: "internal"
        // Remote message/details are not displayed or recorded; they can contain untrusted content.
        return RcpClientException(code, "Request failed")
    }
}
