package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.crypto.signRelayChallenge
import io.github.lottooss.remora.core.crypto.RelayAuthFields
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.protocol.DataFrame
import io.github.lottooss.remora.core.protocol.PeerKind
import io.github.lottooss.remora.core.protocol.RLY_SUBPROTOCOL
import io.github.lottooss.remora.core.protocol.RLY_VERSION
import io.github.lottooss.remora.core.protocol.decodeDataFrame
import io.github.lottooss.remora.core.protocol.encodeDataFrame
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.min
import kotlin.random.Random

data class RelayPeer(
    val id: String,
    val kind: PeerKind,
    val online: Boolean,
    val lastSeenAt: Long? = null,
)

interface WebSocketFactory {
    fun createWebSocket(request: Request, listener: WebSocketListener): WebSocket
}

class DefaultWebSocketFactory(private val client: OkHttpClient) : WebSocketFactory {
    override fun createWebSocket(request: Request, listener: WebSocketListener): WebSocket {
        return client.newWebSocket(request, listener)
    }
}

/**
 * RLY/1 client managing the WebSocket connection to the relay, challenge authentication,
 * data frame multiplexing, and presence tracking.
 */
class RelayClient(
    val relayOrigin: String,
    val deviceId: String,
    val relayPrivateKey: ByteArray,
    private val appVersion: String = "1.0.0",
    private val webSocketFactory: WebSocketFactory = DefaultWebSocketFactory(OkHttpClient()),
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    private val minBackoffMs: Long = 500,
    private val maxBackoffMs: Long = 30_000,
) {

    private val json = Json { ignoreUnknownKeys = true }
    @Volatile private var webSocket: WebSocket? = null
    @Volatile private var isClosedManually = false
    private var backoffMs = minBackoffMs
    private var reconnectJob: Job? = null
    private var pingJob: Job? = null
    private var authenticationJob: Job? = null
    @Volatile private var generation = 0L
    private var lastPongAt = 0L

    private val _connectionState = MutableStateFlow(ConnectionState.Idle)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _incomingDataFrames = MutableSharedFlow<DataFrame>(extraBufferCapacity = 128)
    val incomingDataFrames: SharedFlow<DataFrame> = _incomingDataFrames.asSharedFlow()

    private val _presenceFlow = MutableSharedFlow<RelayPeer>(replay = 16, extraBufferCapacity = 16)
    val presenceFlow: SharedFlow<RelayPeer> = _presenceFlow.asSharedFlow()

    private val pendingRequests = ConcurrentHashMap<String, CompletableDeferred<JsonObject>>()
    private val reqCounter = AtomicLong(1L)

    fun connect() {
        isClosedManually = false
        reconnectJob?.cancel()
        if (_connectionState.value == ConnectionState.Connecting ||
            _connectionState.value == ConnectionState.Authenticating ||
            _connectionState.value == ConnectionState.Ready
        ) {
            return
        }
        initiateConnection()
    }

    fun disconnect() {
        generation++
        authenticationJob?.cancel()
        isClosedManually = true
        reconnectJob?.cancel()
        pingJob?.cancel()
        _connectionState.value = ConnectionState.Idle
        try {
            webSocket?.send("""{"t":"bye","reason":"disconnect"}""")
            webSocket?.close(1000, "Normal closure")
        } catch (_: Exception) {}
        webSocket = null
        failPendingRequests(Exception("Disconnected"))
    }

    suspend fun sendData(channel: Long, peerKind: PeerKind, peerId: ByteArray, payload: ByteArray) {
        check(_connectionState.value == ConnectionState.Ready) { "Relay disconnected" }
        val frameBytes = encodeDataFrame(channel, peerKind, peerId, payload)
        val ws = webSocket ?: throw IllegalStateException("Relay WebSocket not connected")
        val success = ws.send(frameBytes.toByteString())
        if (!success) {
            throw IllegalStateException("Failed to queue data frame to WebSocket")
        }
    }

    suspend fun request(type: String, params: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 10_000): JsonObject {
        if (_connectionState.value != ConnectionState.Ready) {
            throw IllegalStateException("RelayClient not in Ready state (current: ${_connectionState.value})")
        }
        check(pendingRequests.size < 32) { "Too many pending relay requests" }
        require(params["t"] == null && params["rid"] == null) { "Reserved relay field" }
        val rid = "r_${reqCounter.getAndIncrement()}"
        val deferred = CompletableDeferred<JsonObject>()
        pendingRequests[rid] = deferred

        val wireObj = buildJsonObject {
            put("t", type)
            put("rid", rid)
            params.forEach { (k, v) -> put(k, v) }
        }

        try {
            val ws = webSocket ?: throw IllegalStateException("Relay disconnected")
            check(ws.send(wireObj.toString())) { "Relay send failed" }
            val response = kotlinx.coroutines.withTimeout(timeoutMs) { deferred.await() }
            check(response["t"]?.jsonPrimitive?.content != "error") { "Relay request rejected" }
            return response
        } finally { pendingRequests.remove(rid) }
    }

    private fun initiateConnection() {
        val connectionGeneration = ++generation
        _connectionState.value = ConnectionState.Connecting
        val origin = java.net.URI(relayOrigin)
        require(origin.scheme == "https" || (origin.scheme == "http" && origin.host in setOf("127.0.0.1", "10.0.2.2"))) { "Invalid relay origin" }
        require(origin.rawUserInfo == null && origin.rawQuery == null && origin.rawFragment == null && (origin.path.isNullOrEmpty() || origin.path == "/"))

        val wsUrl = relayOrigin.replaceFirst("^http:".toRegex(), "ws:")
            .replaceFirst("^https:".toRegex(), "wss:")
            .trimEnd('/') + "/v1/connect"

        val request = Request.Builder()
            .url(wsUrl)
            .header("Sec-WebSocket-Protocol", RLY_SUBPROTOCOL)
            .build()

        webSocket = webSocketFactory.createWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (connectionGeneration != generation) { webSocket.cancel(); return }
                this@RelayClient.webSocket = webSocket
                if (response.header("Sec-WebSocket-Protocol") != RLY_SUBPROTOCOL) {
                    isClosedManually = true
                    webSocket.cancel()
                    handleConnectionLoss()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (connectionGeneration == generation) handleControlMessage(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (connectionGeneration == generation) handleDataMessage(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (connectionGeneration != generation) return
                if (code in setOf(4401, 4403, 4409, 4426)) isClosedManually = true
                handleConnectionLoss()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (connectionGeneration == generation) handleConnectionLoss()
            }
        })
        authenticationJob?.cancel()
        authenticationJob = scope.launch {
            delay(10_000)
            if (connectionGeneration == generation && _connectionState.value != ConnectionState.Ready) {
                webSocket?.cancel()
                handleConnectionLoss()
            }
        }
    }

    private fun handleControlMessage(text: String) {
        try {
            require(text.toByteArray().size <= 65_536)
            val root = json.parseToJsonElement(text).jsonObject
            val type = root["t"]?.jsonPrimitive?.content ?: return

            when (type) {
                "challenge" -> {
                    require(_connectionState.value == ConnectionState.Connecting)
                    require(root["v"]?.jsonPrimitive?.intOrNull == RLY_VERSION)
                    _connectionState.value = ConnectionState.Authenticating
                    val nonce = root["nonce"]?.jsonPrimitive?.content ?: return
                    val sig = signRelayChallenge(relayPrivateKey, RelayAuthFields(relayOrigin, "device", deviceId, decodeBase64Url(nonce)))
                    val authMessage = buildJsonObject {
                        put("t", "auth")
                        put("v", RLY_VERSION)
                        put("kind", "device")
                        put("id", deviceId)
                        put("sig", encodeBase64Url(sig))
                        put("app", buildJsonObject {
                            put("name", "remora-android")
                            put("version", appVersion)
                        })
                    }
                    webSocket?.send(authMessage.toString())
                }

                "ready" -> {
                    require(_connectionState.value == ConnectionState.Authenticating)
                    require(root["v"]?.jsonPrimitive?.intOrNull == RLY_VERSION)
                    require(root["id"]?.jsonPrimitive?.content == deviceId)
                    authenticationJob?.cancel()
                    lastPongAt = System.nanoTime()
                    _connectionState.value = ConnectionState.Ready
                    backoffMs = minBackoffMs
                    startPingLoop()
                    val peers = root["peers"]?.jsonArray
                    peers?.forEach { peerElem ->
                        val p = peerElem.jsonObject
                        val id = p["id"]?.jsonPrimitive?.content ?: return@forEach
                        val kind = if (p["kind"]?.jsonPrimitive?.content == "host") PeerKind.HOST else PeerKind.DEVICE
                        val online = p["online"]?.jsonPrimitive?.booleanOrNull ?: false
                        val lastSeen = p["lastSeenAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                        _presenceFlow.tryEmit(RelayPeer(id, kind, online, lastSeen))
                    }
                }

                "presence" -> {
                    val id = root["id"]?.jsonPrimitive?.content ?: return
                    val kind = if (root["kind"]?.jsonPrimitive?.content == "host") PeerKind.HOST else PeerKind.DEVICE
                    val online = root["online"]?.jsonPrimitive?.booleanOrNull ?: false
                    val lastSeen = root["at"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                    _presenceFlow.tryEmit(RelayPeer(id, kind, online, lastSeen))
                }

                "ping" -> {
                    webSocket?.send("""{"t":"pong"}""")
                }

                "pong" -> {
                    lastPongAt = System.nanoTime()
                }

                else -> {
                    val rid = root["rid"]?.jsonPrimitive?.content
                    if (rid != null) {
                        val pending = pendingRequests.remove(rid)
                        pending?.complete(root)
                    }
                }
            }
        } catch (_: Exception) { webSocket?.cancel(); handleConnectionLoss() }
    }

    private fun handleDataMessage(bytes: ByteArray) {
        try {
            val frame = decodeDataFrame(bytes)
            if (!_incomingDataFrames.tryEmit(frame)) {
                webSocket?.cancel(); handleConnectionLoss()
            }
        } catch (_: Exception) { webSocket?.cancel(); handleConnectionLoss() }
    }

    @Synchronized
    private fun handleConnectionLoss() {
        if (_connectionState.value == ConnectionState.Backoff || (_connectionState.value == ConnectionState.Idle && isClosedManually)) return
        generation++
        webSocket?.cancel()
        webSocket = null
        authenticationJob?.cancel()
        pingJob?.cancel()
        failPendingRequests(Exception("Connection lost"))
        if (isClosedManually) {
            _connectionState.value = ConnectionState.Idle
            return
        }

        _connectionState.value = ConnectionState.Backoff
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            val jitter = Random.nextLong(0, min(backoffMs / 2, 1000).coerceAtLeast(1))
            delay(backoffMs + jitter)
            backoffMs = min(backoffMs * 2, maxBackoffMs)
            if (!isClosedManually) {
                initiateConnection()
            }
        }
    }

    private fun startPingLoop() {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (_connectionState.value == ConnectionState.Ready) {
                delay(25_000)
                try {
                    if (System.nanoTime() - lastPongAt > 60_000_000_000L || webSocket?.send("""{"t":"ping"}""") != true) {
                        handleConnectionLoss()
                        break
                    }
                } catch (_: Exception) {
                    break
                }
            }
        }
    }

    private fun failPendingRequests(error: Throwable) {
        val keys = pendingRequests.keys().toList()
        for (k in keys) {
            pendingRequests.remove(k)?.completeExceptionally(error)
        }
    }

    companion object {
        suspend fun enrollDevice(
            relayOrigin: String,
            ticket: ByteArray,
            relayPub: ByteArray,
            name: String,
            platform: String = "android",
            client: OkHttpClient = OkHttpClient(),
        ): Pair<String, String> = kotlinx.coroutines.withContext(Dispatchers.IO) {
            val url = relayOrigin.trimEnd('/') + "/v1/enroll/device"
            val bodyJson = buildJsonObject {
                put("v", 1)
                put("ticket", encodeBase64Url(ticket))
                put("relayPub", encodeBase64Url(relayPub))
                put("name", name)
                put("platform", platform)
            }.toString()

            val mediaType = "application/json".toMediaType()
            val requestBody = okhttp3.RequestBody.create(mediaType, bodyJson)
            val request = Request.Builder()
                .url(url)
                .post(requestBody)
                .build()

            client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IllegalStateException("Device enrollment failed: HTTP ${response.code}")
            }
            val resBody = response.body?.string() ?: throw IllegalStateException("Empty enrollment response")
            val root = Json { ignoreUnknownKeys = true }.parseToJsonElement(resBody).jsonObject
            val deviceId = root["id"]?.jsonPrimitive?.content ?: throw IllegalStateException("Missing deviceId")
            val hostId = root["hostId"]?.jsonPrimitive?.content ?: throw IllegalStateException("Missing hostId")
            deviceId to hostId
            }
        }
    }
}
