package io.github.lottooss.remora.core.data

import android.content.Context
import android.content.SharedPreferences
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.model.Host
import io.github.lottooss.remora.core.model.HostId
import io.github.lottooss.remora.core.security.KeyStorage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.json.*

interface HostRepository {
    val hosts: StateFlow<List<Host>>
    val activeHost: StateFlow<Host?>
    suspend fun addHost(host: Host)
    suspend fun updateHost(host: Host)
    suspend fun removeHost(hostId: HostId)
    suspend fun setActiveHost(hostId: HostId?)
}

/**
 * Repository for managing paired hosts and active selection with persistence.
 */
class DefaultHostRepository(
    private val context: Context? = null,
    private val keyStorage: KeyStorage? = null,
) : HostRepository {

    private val prefs: SharedPreferences? by lazy {
        context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private val inMemoryHosts = ConcurrentHashMap<String, Host>()
    private val _hosts = MutableStateFlow<List<Host>>(emptyList())
    override val hosts: StateFlow<List<Host>> = _hosts.asStateFlow()

    private val _activeHost = MutableStateFlow<Host?>(null)
    override val activeHost: StateFlow<Host?> = _activeHost.asStateFlow()

    init {
        loadHosts()
    }

    override suspend fun addHost(host: Host) {
        inMemoryHosts[host.id.value] = host
        saveHosts()
        if (_activeHost.value == null) {
            setActiveHost(host.id)
        }
    }

    override suspend fun updateHost(host: Host) {
        if (inMemoryHosts.containsKey(host.id.value)) {
            inMemoryHosts[host.id.value] = host
            saveHosts()
            if (_activeHost.value?.id == host.id) {
                _activeHost.value = host
            }
        }
    }

    override suspend fun removeHost(hostId: HostId) {
        inMemoryHosts.remove(hostId.value)
        keyStorage?.wipeHost(hostId.value)
        saveHosts()
        if (_activeHost.value?.id == hostId) {
            setActiveHost(inMemoryHosts.values.firstOrNull()?.id)
        }
    }

    override suspend fun setActiveHost(hostId: HostId?) {
        if (hostId == null) {
            _activeHost.value = null
        } else {
            _activeHost.value = inMemoryHosts[hostId.value]
        }
        prefs?.edit()?.putString("active_host", _activeHost.value?.id?.value)?.apply()
    }

    private fun loadHosts() {
        val serialized = prefs?.getString(KEY_HOSTS_LIST, null)
        if (serialized != null) {
            val list = deserializeHosts(serialized)
            list.forEach { inMemoryHosts[it.id.value] = it }
            _hosts.value = inMemoryHosts.values.toList()
            _activeHost.value = list.firstOrNull { it.id.value == prefs?.getString("active_host", null) } ?: list.firstOrNull()
        } else {
            _hosts.value = inMemoryHosts.values.toList()
        }
    }

    private fun saveHosts() {
        val currentList = inMemoryHosts.values.toList()
        _hosts.value = currentList
        prefs?.edit()?.putString(KEY_HOSTS_LIST, serializeHosts(currentList))?.apply()
    }

    private fun serializeHosts(hosts: List<Host>): String = JsonArray(hosts.map { h ->
        buildJsonObject {
            put("id", h.id.value); put("name", h.name); put("relayOrigin", h.relayOrigin)
            put("noisePub", encodeBase64Url(h.hostNoisePub)); put("lastSeenAt", h.lastSeenAt)
        }
    }).toString()

    private fun deserializeHosts(raw: String): List<Host> {
        if (raw.isBlank() || raw.length > 131_072) return emptyList()
        if (raw.startsWith("[")) return try {
            Json.parseToJsonElement(raw).jsonArray.take(32).map { value ->
                val obj = value.jsonObject
                val publicKey = decodeBase64Url(obj.getValue("noisePub").jsonPrimitive.content)
                require(publicKey.size == 32)
                Host(HostId(obj.getValue("id").jsonPrimitive.content), obj.getValue("name").jsonPrimitive.content,
                    obj.getValue("relayOrigin").jsonPrimitive.content, publicKey,
                    isOnline = false, lastSeenAt = obj["lastSeenAt"]?.jsonPrimitive?.longOrNull ?: 0)
            }
        } catch (_: Exception) { emptyList() }
        // Upgrade the original on-disk format on the next write.
        val entries = raw.split("\n---\n")
        return entries.mapNotNull { entry ->
            try {
                val lines = entry.split("\n")
                if (lines.size < 6) return@mapNotNull null
                Host(
                    id = HostId(lines[0]),
                    name = lines[1],
                    relayOrigin = lines[2],
                    hostNoisePub = decodeBase64Url(lines[3]),
                    isOnline = false,
                    lastSeenAt = lines[5].toLong(),
                )
            } catch (_: Exception) {
                null
            }
        }
    }

    companion object {
        private const val PREFS_NAME = "remora_hosts_repo"
        private const val KEY_HOSTS_LIST = "paired_hosts"
    }
}
