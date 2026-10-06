package io.github.lottooss.remora.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Diagnostics accept fixed event codes only, never arbitrary log text or exception messages. */
class DiagnosticsRepository {
    private val entries = MutableStateFlow<List<String>>(emptyList())
    val lines: StateFlow<List<String>> = entries.asStateFlow()
    @Synchronized
    fun record(hostId: String?, event: Event) {
        val id = hostId?.take(6)?.takeIf { it.matches(Regex("[a-z0-9_]{1,6}")) } ?: "app"
        entries.value = (entries.value + "${System.currentTimeMillis()} $id ${event.name.lowercase()}").takeLast(200)
    }
    fun report(appVersion: String, hostVersion: String? = null, dshVersion: String? = null): String {
        fun safe(value: String?) = value?.take(60)?.takeIf { it.matches(Regex("[A-Za-z0-9.+_-]+")) } ?: "unavailable"
        return "Remora ${safe(appVersion)}\nHost ${safe(hostVersion)}\ndsh ${safe(dshVersion)}\nRCP 1 · RLY 1 · SC 1\n\n" + entries.value.joinToString("\n")
    }
    enum class Event { IDLE, CONNECTING, AUTHENTICATING, HANDSHAKING, READY, BACKOFF, PUSH_REJECTED, TOKEN_PENDING, TOKEN_REGISTERED, OPERATION_FAILED }
}
