package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.crypto.Keypair
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*

data class HostConnectionInfo(
    val hostId: String,
    val hostNoisePub: ByteArray,
    val relayOrigin: String,
    val deviceId: String,
    val relayPrivateKey: ByteArray,
    val noiseKeypair: Keypair,
    val devicePsk: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as HostConnectionInfo
        return hostId == other.hostId &&
            hostNoisePub.contentEquals(other.hostNoisePub) &&
            relayOrigin == other.relayOrigin &&
            deviceId == other.deviceId &&
            relayPrivateKey.contentEquals(other.relayPrivateKey) &&
            noiseKeypair == other.noiseKeypair &&
            devicePsk.contentEquals(other.devicePsk)
    }

    override fun hashCode(): Int {
        var result = hostId.hashCode()
        result = 31 * result + hostNoisePub.contentHashCode()
        result = 31 * result + relayOrigin.hashCode()
        result = 31 * result + deviceId.hashCode()
        result = 31 * result + relayPrivateKey.contentHashCode()
        result = 31 * result + noiseKeypair.hashCode()
        result = 31 * result + devicePsk.contentHashCode()
        return result
    }

    override fun toString(): String {
        return "HostConnectionInfo(hostId=${hostId.take(6)}, deviceId=${deviceId.take(6)}, [REDACTED])"
    }
}

/** Owns one foreground host connection and disposes each previous channel before reconnecting. */
class ConnectionManager(
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    private val appVersion: String = "1.0.0",
) {
    private val state = MutableStateFlow(ConnectionState.Idle)
    val connectionState: StateFlow<ConnectionState> = state.asStateFlow()
    private val host = MutableStateFlow<String?>(null)
    val activeHostId: StateFlow<String?> = host.asStateFlow()
    private val client = MutableStateFlow<RcpClient?>(null)
    val rcpClient: StateFlow<RcpClient?> = client.asStateFlow()
    private val relay = MutableStateFlow<RelayClient?>(null)
    val relayClient: StateFlow<RelayClient?> = relay.asStateFlow()
    private val greeting = MutableStateFlow<JsonObject?>(null)
    val hello: StateFlow<JsonObject?> = greeting.asStateFlow()
    private val peers = MutableSharedFlow<RelayPeer>(extraBufferCapacity = 32)
    val presence: SharedFlow<RelayPeer> = peers.asSharedFlow()
    private var connectionJob: Job? = null
    private var secureChannel: SecureChannel? = null
    private var currentRcp: RcpClient? = null
    @Volatile private var generation = 0L

    fun connect(info: HostConnectionInfo) {
        disconnect()
        val currentGeneration = ++generation
        // The caller may wipe its storage result immediately after connect returns.
        val owned = info.copy(
            hostNoisePub = info.hostNoisePub.copyOf(), relayPrivateKey = info.relayPrivateKey.copyOf(),
            noiseKeypair = Keypair(info.noiseKeypair.secretKey.copyOf(), info.noiseKeypair.publicKey.copyOf()),
            devicePsk = info.devicePsk.copyOf(),
        )
        host.value = owned.hostId
        state.value = ConnectionState.Connecting
        connectionJob = scope.launch(Dispatchers.IO) {
            var ownedRelay: RelayClient? = null
            try {
                coroutineScope {
                    val rly = RelayClient(owned.relayOrigin, owned.deviceId, owned.relayPrivateKey, appVersion, scope = this)
                    ownedRelay = rly
                    relay.value = rly
                    launch(start = CoroutineStart.UNDISPATCHED) { rly.presenceFlow.collect { peers.emit(it) } }
                    launch(start = CoroutineStart.UNDISPATCHED) {
                        rly.connectionState.collectLatest { relayState ->
                            if (currentGeneration != generation) return@collectLatest
                            disposeChannel()
                            if (relayState != ConnectionState.Ready) {
                                state.value = relayState
                                return@collectLatest
                            }
                            var retry = 500L
                            while (isActive && currentGeneration == generation) {
                                try {
                                    state.value = ConnectionState.Handshaking
                                    val channel = SecureChannel(hostId = owned.hostId, deviceId = owned.deviceId,
                                        hostNoisePub = owned.hostNoisePub, deviceNoiseKeypair = owned.noiseKeypair,
                                        relayClient = rly, scope = this)
                                    secureChannel = channel
                                    channel.handshake("session", owned.devicePsk,
                                        buildJsonObject { put("v", 1); put("purpose", "session"); put("app", buildJsonObject { put("version", appVersion) }) }.toString())
                                    val rcp = RcpClient(channel, this)
                                    currentRcp = rcp
                                    val response = rcp.call("hello", buildJsonObject {
                                        put("rcp", JsonArray(listOf(JsonPrimitive(1))))
                                        put("app", buildJsonObject { put("name", "remora-android"); put("version", appVersion) })
                                    }).jsonObject
                                    require(response["rcp"]?.jsonPrimitive?.intOrNull == 1)
                                    require(response["host"]?.jsonObject?.get("id")?.jsonPrimitive?.content == owned.hostId)
                                    greeting.value = response
                                    client.value = rcp
                                    state.value = ConnectionState.Ready
                                    retry = 500L
                                    withTimeoutOrNull(86_400_000) { channel.closed.await() }
                                } catch (_: TimeoutCancellationException) { state.value = ConnectionState.Backoff }
                                catch (cancelled: CancellationException) { throw cancelled }
                                catch (_: Exception) { state.value = ConnectionState.Backoff }
                                finally { if (currentGeneration == generation) disposeChannel() }
                                state.value = ConnectionState.Backoff
                                delay(retry)
                                retry = (retry * 2).coerceAtMost(30_000)
                            }
                        }
                    }
                    rly.connect()
                    awaitCancellation()
                }
            } finally {
                ownedRelay?.disconnect()
                if (currentGeneration == generation) {
                    disposeChannel()
                    relay.value = null
                    state.value = ConnectionState.Idle
                }
                owned.relayPrivateKey.fill(0); owned.noiseKeypair.secretKey.fill(0); owned.devicePsk.fill(0)
            }
        }
        connectionJob?.invokeOnCompletion {
            owned.relayPrivateKey.fill(0); owned.noiseKeypair.secretKey.fill(0); owned.devicePsk.fill(0)
        }
    }

    private fun disposeChannel() {
        currentRcp?.close(); currentRcp = null; client.value = null
        secureChannel?.close(); secureChannel = null
    }

    fun disconnect() {
        generation++
        connectionJob?.cancel(); connectionJob = null
        disposeChannel()
        relay.value?.disconnect(); relay.value = null
        greeting.value = null
        host.value = null
        state.value = ConnectionState.Idle
    }
}
