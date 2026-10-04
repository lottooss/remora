package io.github.lottooss.remora.core.data

import android.content.Context
import io.github.lottooss.remora.core.security.KeyStorage
import io.github.lottooss.remora.core.transport.ConnectionState
import io.github.lottooss.remora.core.transport.RelayClient
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*

/** Persists token updates and retries each paired relay identity without putting a token in logs. */
class PushTokenRegistrar(
    context: Context,
    private val hosts: HostRepository,
    private val keys: KeyStorage,
    private val relayForHost: (String) -> RelayClient? = { null },
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
) {
    private val prefs = context.applicationContext.getSharedPreferences("remora_push", Context.MODE_PRIVATE)
    private val lock = Mutex()
    private val registered = mutableMapOf<String, Pair<String, Boolean>>()
    private var retryJob: Job? = null
    private var updateJob: Job? = null

    /** Called while visible. Pairing/host-list changes are retried by the same bounded worker. */
    fun start() {
        if (retryJob?.isActive == true) return
        retryJob = scope.launch {
            while (isActive) { registerAll(); delay(30_000) }
        }
    }

    fun stop() { retryJob?.cancel(); retryJob = null }

    fun updateToken(token: String) {
        require(token.isNotBlank() && token.length <= 8_192) { "Invalid push token" }
        prefs.edit().putString("token", token).apply()
        // This job has application scope, so Firebase service destruction does not erase the update.
        updateJob?.cancel()
        updateJob = scope.launch { registerAll() }
    }

    fun preference(hostId: String): Boolean = prefs.getBoolean("offline_$hostId", true)

    fun setHostOffline(hostId: String, enabled: Boolean) {
        prefs.edit().putBoolean("offline_$hostId", enabled).apply()
        updateJob?.cancel()
        updateJob = scope.launch { registerAll() }
    }

    /** May be called after relay ready so a previous offline attempt is retried immediately. */
    suspend fun registerWithRelay(hostId: String, relay: RelayClient) = lock.withLock {
        registerReady(hostId, relay)
    }

    suspend fun registerAll() = lock.withLock {
        val paired = hosts.hosts.value
        registered.keys.retainAll(paired.map { it.id.value }.toSet())
        for (host in paired) {
            val token = prefs.getString("token", null) ?: return@withLock
            val desired = token to preference(host.id.value)
            if (registered[host.id.value] == desired) continue
            try {
                val existing = relayForHost(host.id.value)
                if (existing != null) {
                    withTimeout(12_000) { existing.connectionState.first { it == ConnectionState.Ready } }
                    registerReady(host.id.value, existing)
                } else {
                    val material = keys.getHostKeys(host.id.value) ?: continue
                    try {
                        coroutineScope {
                            val temporary = RelayClient(host.relayOrigin, material.deviceId, material.relayPrivKey, scope = this)
                            try {
                                temporary.connect()
                                withTimeout(12_000) { temporary.connectionState.first { it == ConnectionState.Ready } }
                                registerReady(host.id.value, temporary)
                            } finally { temporary.disconnect() }
                        }
                    } finally { material.wipe() }
                }
            } catch (cancelled: CancellationException) {
                if (cancelled !is TimeoutCancellationException) throw cancelled
            } catch (_: Exception) { /* Persisted token remains pending for the next connection. */ }
        }
    }

    private suspend fun registerReady(hostId: String, relay: RelayClient) {
        val token = prefs.getString("token", null) ?: return
        val offline = preference(hostId)
        val response = relay.request("push.token", buildJsonObject { put("token", token); put("hostOffline", offline) })
        check(response["t"]?.jsonPrimitive?.content == "ok") { "Token registration was not acknowledged" }
        registered[hostId] = token to offline
    }
}
