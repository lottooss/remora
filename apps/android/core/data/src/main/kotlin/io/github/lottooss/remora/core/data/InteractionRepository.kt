package io.github.lottooss.remora.core.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map

/**
 * In-memory repository tracking pending approvals and questions across hosts and sessions.
 */
class InteractionRepository {

    private val _interactions = MutableStateFlow<Map<String, PendingInteraction>>(emptyMap())
    val pendingInteractions: StateFlow<List<PendingInteraction>> =
        MutableStateFlow<List<PendingInteraction>>(emptyList()).also { stateFlow ->
            // Update backing list whenever map updates
        }

    private val _interactionsList = MutableStateFlow<List<PendingInteraction>>(emptyList())
    val allPending: StateFlow<List<PendingInteraction>> = _interactionsList.asStateFlow()

    private val _resolvedEvents = MutableSharedFlow<ResolvedNotice>(replay = 1, extraBufferCapacity = 64)
    val resolvedEvents: SharedFlow<ResolvedNotice> = _resolvedEvents.asSharedFlow()

    fun getPendingForSession(sessionId: String): Flow<List<PendingInteraction>> {
        return allPending.map { list ->
            list.filter { it.sessionId == sessionId }
        }
    }

    fun setPending(items: List<PendingInteraction>) {
        val map = items.associateBy { it.id }
        _interactions.value = map
        _interactionsList.value = items
    }

    fun addOrUpdate(item: PendingInteraction) {
        val current = _interactions.value.toMutableMap()
        current[item.id] = item
        _interactions.value = current
        _interactionsList.value = current.values.toList()
    }

    fun resolve(id: String, by: String) {
        val current = _interactions.value.toMutableMap()
        if (current.remove(id) != null) {
            _interactions.value = current
            _interactionsList.value = current.values.toList()
            _resolvedEvents.tryEmit(ResolvedNotice(id = id, by = by))
        }
    }

    fun clear() {
        _interactions.value = emptyMap()
        _interactionsList.value = emptyList()
    }
}
