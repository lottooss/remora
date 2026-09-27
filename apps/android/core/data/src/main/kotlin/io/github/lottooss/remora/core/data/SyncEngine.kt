package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.concurrent.ConcurrentHashMap

enum class SyncState {
    IDLE,
    CONNECTING,
    SYNCING,
    LIVE,
    OFFLINE,
    ERROR,
}

/**
 * SyncEngine manages sessions.follow streams across visibility lifecycles,
 * handles monotonic live delta overlays that retire on durable event settlement,
 * processes server reset frames, and resumes afterSeq after network interruptions.
 */
class SyncEngine(
    private val sessionRepository: SessionRepository,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + Job()),
) {

    private val followJobs = ConcurrentHashMap<String, Job>()
    private val activeStreams = ConcurrentHashMap<String, Long>() // sessionId -> streamId
    private val syncStates = ConcurrentHashMap<String, MutableStateFlow<SyncState>>()
    private val liveOverlays = ConcurrentHashMap<String, MutableStateFlow<LiveDeltaOverlay?>>()

    fun getSyncState(sessionId: String): StateFlow<SyncState> {
        return syncStates.computeIfAbsent(sessionId) {
            MutableStateFlow(SyncState.IDLE)
        }.asStateFlow()
    }

    fun getLiveOverlay(sessionId: String): StateFlow<LiveDeltaOverlay?> {
        return liveOverlays.computeIfAbsent(sessionId) {
            MutableStateFlow(null)
        }.asStateFlow()
    }

    /**
     * Opens sessions.follow stream for the given sessionId.
     * If an existing stream is already active, it is cancelled first.
     */
    fun openFollow(sessionId: String, rcpClient: RcpClient) {
        closeFollow(sessionId)

        val stateFlow = syncStates.computeIfAbsent(sessionId) { MutableStateFlow(SyncState.IDLE) }
        stateFlow.value = SyncState.CONNECTING

        val job = scope.launch {
            try {
                val highestSeq = sessionRepository.getHighestSeq(sessionId)
                val params = buildJsonObject {
                    put("sessionId", sessionId)
                    if (highestSeq > 0L) {
                        put("afterSeq", highestSeq)
                    }
                    put("live", true)
                }

                val flow = rcpClient.openStream("sessions.follow", params)
                stateFlow.value = SyncState.SYNCING

                flow.collect { item ->
                    if (item is JsonObject) {
                        handleFollowItem(sessionId, item)
                    }
                    if (stateFlow.value == SyncState.SYNCING) {
                        stateFlow.value = SyncState.LIVE
                    }
                }
                stateFlow.value = SyncState.OFFLINE
            } catch (_: Exception) {
                stateFlow.value = SyncState.ERROR
            } finally {
                followJobs.remove(sessionId)
            }
        }

        followJobs[sessionId] = job
    }

    /**
     * Closes the active follow stream for sessionId when view leaves foreground.
     */
    fun closeFollow(sessionId: String) {
        followJobs.remove(sessionId)?.cancel()
        syncStates[sessionId]?.value = SyncState.IDLE
    }

    fun handleFollowItem(sessionId: String, item: JsonObject) {
        val type = item["type"]?.jsonPrimitive?.content ?: return

        when (type) {
            "snapshot" -> {
                val sessionObj = item["session"]?.jsonObject
                if (sessionObj != null) {
                    val summary = SessionCodecs.parseSessionSummary(sessionObj)
                    sessionRepository.upsertSession(summary)
                }

                val eventsArr = item["events"]?.jsonArray
                val events = eventsArr?.mapNotNull {
                    if (it is JsonObject) SessionCodecs.parseSessionEvent(it) else null
                } ?: emptyList()

                val hasOlder = item["hasOlder"]?.jsonPrimitive?.booleanOrNull ?: false
                sessionRepository.setHasOlder(sessionId, hasOlder)
                sessionRepository.appendEvents(sessionId, events)

                // Settlement: retire any prior live overlay
                liveOverlays[sessionId]?.value = null
            }

            "events" -> {
                val eventsArr = item["events"]?.jsonArray
                val events = eventsArr?.mapNotNull {
                    if (it is JsonObject) SessionCodecs.parseSessionEvent(it) else null
                } ?: emptyList()

                sessionRepository.appendEvents(sessionId, events)

                // If durable assistant message arrived, retire live overlay
                if (events.any { it is SessionEvent.AssistantMessage || it is SessionEvent.TurnEnd }) {
                    liveOverlays[sessionId]?.value = null
                }
            }

            "live.start" -> {
                val attempt = item["attempt"]?.jsonPrimitive?.content ?: ""
                liveOverlays.computeIfAbsent(sessionId) { MutableStateFlow(null) }.value =
                    LiveDeltaOverlay(attempt = attempt, text = "", reasoning = "", active = true)
            }

            "live.delta" -> {
                val attempt = item["attempt"]?.jsonPrimitive?.content ?: ""
                val deltaText = item["text"]?.jsonPrimitive?.content ?: ""
                val deltaReasoning = item["reasoning"]?.jsonPrimitive?.content ?: ""

                val overlayFlow = liveOverlays.computeIfAbsent(sessionId) { MutableStateFlow(null) }
                val current = overlayFlow.value

                if (current != null && current.attempt == attempt) {
                    overlayFlow.value = current.copy(
                        text = current.text + deltaText,
                        reasoning = current.reasoning + deltaReasoning,
                    )
                } else {
                    overlayFlow.value = LiveDeltaOverlay(
                        attempt = attempt,
                        text = deltaText,
                        reasoning = deltaReasoning,
                        active = true,
                    )
                }
            }

            "live.end" -> {
                val outcome = item["outcome"]?.jsonPrimitive?.content
                if (outcome == "abandoned") {
                    liveOverlays[sessionId]?.value = null
                }
            }

            "reset" -> {
                // Reason: 'cursor_unavailable' | 'session_replaced'
                sessionRepository.clearEvents(sessionId)
                liveOverlays[sessionId]?.value = null
            }
        }
    }
}
