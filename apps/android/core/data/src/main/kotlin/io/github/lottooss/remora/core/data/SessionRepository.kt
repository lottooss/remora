package io.github.lottooss.remora.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.util.concurrent.ConcurrentHashMap

/**
 * Thread-safe repository managing sessions and their event histories.
 * In accordance with P2-K2 deliverables, event storage is strictly bounded to 2,000 events
 * per session to guarantee smooth scrolling and bounded memory.
 */
class SessionRepository(
    private val maxEventsPerSession: Int = MAX_EVENTS_PER_SESSION,
) {
    companion object {
        const val MAX_EVENTS_PER_SESSION = 2000
    }

    private val _sessions = MutableStateFlow<List<SessionSummary>>(emptyList())
    val sessions: StateFlow<List<SessionSummary>> = _sessions.asStateFlow()

    private val eventFlows = ConcurrentHashMap<String, MutableStateFlow<List<SessionEvent>>>()
    private val hasOlderMap = ConcurrentHashMap<String, Boolean>()

    private val controls = MutableStateFlow<Map<String, ControlState>>(emptyMap())
    val controlStates: StateFlow<Map<String, ControlState>> = controls.asStateFlow()

    fun setControlStates(states: List<ControlState>) { controls.value = states.associateBy { it.sessionId } }
    fun updateControlState(state: ControlState) { controls.value = controls.value + (state.sessionId to state) }
    fun removeControlState(sessionId: String) { controls.value = controls.value - sessionId }
    fun clear() {
        _sessions.value = emptyList()
        eventFlows.values.forEach { it.value = emptyList() }
        eventFlows.clear(); hasOlderMap.clear(); controls.value = emptyMap()
    }

    fun setSessions(list: List<SessionSummary>) {
        _sessions.value = list.sortedByDescending { it.updatedAt }
    }

    fun upsertSession(session: SessionSummary) {
        val current = _sessions.value.toMutableList()
        val index = current.indexOfFirst { it.id == session.id }
        if (index >= 0) {
            current[index] = session
        } else {
            current.add(session)
        }
        _sessions.value = current.sortedByDescending { it.updatedAt }
    }

    fun getSession(sessionId: String): SessionSummary? {
        return _sessions.value.firstOrNull { it.id == sessionId }
    }

    fun getEventsFlow(sessionId: String): StateFlow<List<SessionEvent>> {
        return eventFlows.computeIfAbsent(sessionId) {
            MutableStateFlow(emptyList())
        }.asStateFlow()
    }

    fun getEvents(sessionId: String): List<SessionEvent> {
        return eventFlows[sessionId]?.value ?: emptyList()
    }

    @Synchronized
    fun appendEvents(sessionId: String, newEvents: List<SessionEvent>) {
        if (newEvents.isEmpty()) return
        val flow = eventFlows.computeIfAbsent(sessionId) { MutableStateFlow(emptyList()) }
        val existing = flow.value
        val existingSeqSet = existing.map { it.seq }.toHashSet()

        val merged = existing.toMutableList()
        for (ev in newEvents) {
            if (!existingSeqSet.contains(ev.seq)) {
                merged.add(ev)
                existingSeqSet.add(ev.seq)
            }
        }
        merged.sortBy { it.seq }

        // Enforce the 2,000 bounded events invariant
        val bounded = if (merged.size > maxEventsPerSession) {
            hasOlderMap[sessionId] = true
            merged.subList(merged.size - maxEventsPerSession, merged.size)
        } else {
            merged
        }

        flow.value = bounded
    }

    @Synchronized
    fun prependOlderEvents(sessionId: String, olderEvents: List<SessionEvent>, hasOlder: Boolean) {
        hasOlderMap[sessionId] = hasOlder
        if (olderEvents.isEmpty()) return

        val flow = eventFlows.computeIfAbsent(sessionId) { MutableStateFlow(emptyList()) }
        val existing = flow.value
        val existingSeqSet = existing.map { it.seq }.toHashSet()

        val merged = olderEvents.filter { !existingSeqSet.contains(it.seq) }.toMutableList()
        merged.addAll(existing)
        merged.sortBy { it.seq }

        val bounded = if (merged.size > maxEventsPerSession) {
            merged.subList(merged.size - maxEventsPerSession, merged.size)
        } else {
            merged
        }

        flow.value = bounded
    }

    @Synchronized
    fun clearEvents(sessionId: String) {
        eventFlows[sessionId]?.value = emptyList()
        hasOlderMap[sessionId] = false
    }

    fun getHighestSeq(sessionId: String): Long {
        val events = eventFlows[sessionId]?.value ?: return 0L
        return events.maxOfOrNull { it.seq } ?: 0L
    }

    fun getLowestSeq(sessionId: String): Long {
        val events = eventFlows[sessionId]?.value ?: return 0L
        return events.minOfOrNull { it.seq } ?: 0L
    }

    fun hasOlder(sessionId: String): Boolean {
        return hasOlderMap[sessionId] ?: false
    }

    fun setHasOlder(sessionId: String, value: Boolean) {
        hasOlderMap[sessionId] = value
    }
}
