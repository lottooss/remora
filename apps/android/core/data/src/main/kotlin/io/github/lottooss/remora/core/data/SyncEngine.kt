package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.collect
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
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
    val interactionRepository: InteractionRepository = InteractionRepository(),
    val workspaceRepository: WorkspaceRepository = WorkspaceRepository(),
) {

    private val followJobs = ConcurrentHashMap<String, Job>()
    private val visibleSessions = ConcurrentHashMap.newKeySet<String>()
    private val liveIndexes = ConcurrentHashMap<String, Long>()
    private var bindingJob: Job? = null
    private var client: RcpClient? = null

    /** Binds the three host streams and restores visible conversation cursors on every channel. */
    fun bind(clients: StateFlow<RcpClient?>) {
        bindingJob?.cancel()
        bindingJob = scope.launch {
            clients.collectLatest { ready ->
                followJobs.values.forEach { it.cancel() }; followJobs.clear()
                client = ready
                interactionRepository.clear()
                if (ready == null) {
                    syncStates.values.forEach { it.value = SyncState.OFFLINE }
                    return@collectLatest
                }
                coroutineScope {
                    launch { maintainStream(ready, "interaction.follow", ::handleInteractionItem) }
                    launch { maintainStream(ready, "sessions.control", ::handleControlItem) }
                    launch { maintainStream(ready, "workspaces.follow", workspaceRepository::apply) }
                    visibleSessions.forEach { openFollow(it, ready) }
                    try { awaitCancellation() } finally {
                        followJobs.values.forEach { it.cancel() }; followJobs.clear()
                    }
                }
            }
        }
    }

    fun watchSession(sessionId: String) {
        visibleSessions.add(sessionId)
        client?.let { openFollow(sessionId, it) }
    }

    fun unwatchSession(sessionId: String) { visibleSessions.remove(sessionId); closeFollow(sessionId) }

    fun closeAll() {
        bindingJob?.cancel(); bindingJob = null; client = null
        followJobs.values.forEach { it.cancel() }; followJobs.clear(); visibleSessions.clear()
        interactionRepository.clear()
        syncStates.values.forEach { it.value = SyncState.IDLE }
        liveOverlays.values.forEach { it.value = null }
    }

    private suspend fun maintainStream(rcp: RcpClient, method: String, consume: (JsonObject) -> Unit) {
        var backoff = 500L
        while (currentCoroutineContext().isActive) {
            try {
                rcp.openStream(method).collect { item -> consume(item.jsonObject); backoff = 500L }
            } catch (_: TimeoutCancellationException) {
                if (method == "interaction.follow") interactionRepository.clear()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) {
                if (method == "interaction.follow") interactionRepository.clear()
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000)
        }
    }

    fun handleInteractionItem(item: JsonObject) {
        when (item["type"]?.jsonPrimitive?.content) {
            "baseline" -> interactionRepository.setPending(item.getValue("pending").jsonArray.map {
                InteractionCodecs.parsePending(it.jsonObject) ?: error("Invalid interaction baseline")
            })
            "requested" -> interactionRepository.addOrUpdate(
                InteractionCodecs.parsePending(item.getValue("pending").jsonObject) ?: error("Invalid interaction"),
            )
            "resolved" -> interactionRepository.resolve(item.getValue("id").jsonPrimitive.content,
                item.getValue("by").jsonPrimitive.content)
        }
    }

    fun handleControlItem(item: JsonObject) {
        when (item["type"]?.jsonPrimitive?.content) {
            "baseline" -> sessionRepository.setControlStates(item.getValue("sessions").jsonArray.map { parseControl(it.jsonObject) })
            "update" -> sessionRepository.updateControlState(parseControl(item.getValue("session").jsonObject))
            "removed" -> sessionRepository.removeControlState(item.getValue("sessionId").jsonPrimitive.content)
        }
    }

    private fun parseControl(obj: JsonObject) = ControlState(
        sessionId = obj.getValue("sessionId").jsonPrimitive.content,
        running = obj.getValue("running").jsonPrimitive.booleanOrNull ?: error("Missing running state"),
        queue = obj.getValue("queue").jsonArray.map { value -> value.jsonObject.let {
            ControlQueueItem(it.getValue("itemId").jsonPrimitive.content, it.getValue("text").jsonPrimitive.content,
                it.getValue("delivery").jsonPrimitive.content)
        } },
        jobs = obj.getValue("jobs").jsonArray.map { value -> value.jsonObject.let {
            ControlJob(it.getValue("id").jsonPrimitive.content, it.getValue("title").jsonPrimitive.content,
                it.getValue("state").jsonPrimitive.content)
        } },
    )
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
        followJobs.remove(sessionId)?.cancel()

        val stateFlow = syncStates.computeIfAbsent(sessionId) { MutableStateFlow(SyncState.IDLE) }
        stateFlow.value = SyncState.CONNECTING

        val job = scope.launch {
            var retry = 500L
            while (currentCoroutineContext().isActive) {
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
            } catch (_: TimeoutCancellationException) { stateFlow.value = SyncState.ERROR }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { stateFlow.value = SyncState.ERROR }
            liveOverlays[sessionId]?.value = null
            delay(retry)
            retry = (retry * 2).coerceAtMost(30_000)
            }
        }

        followJobs[sessionId] = job
    }

    /**
     * Closes the active follow stream for sessionId when view leaves foreground.
     */
    fun closeFollow(sessionId: String) {
        visibleSessions.remove(sessionId)
        followJobs.remove(sessionId)?.cancel()
        liveOverlays[sessionId]?.value = null
        liveIndexes.remove(sessionId)
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
                sessionRepository.clearEvents(sessionId)
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
                if (events.any { it is SessionEvent.AssistantMessage || it is SessionEvent.AssistantAttempt || it is SessionEvent.TurnEnd }) {
                    liveOverlays[sessionId]?.value = null
                }
            }

            "live.start" -> {
                val attempt = item["attempt"]?.jsonPrimitive?.content ?: ""
                liveIndexes[sessionId] = -1L
                liveOverlays.computeIfAbsent(sessionId) { MutableStateFlow(null) }.value =
                    LiveDeltaOverlay(attempt = attempt, text = "", reasoning = "", active = true)
            }

            "live.delta" -> {
                val attempt = item["attempt"]?.jsonPrimitive?.content ?: ""
                val index = item["index"]?.jsonPrimitive?.longOrNull ?: return
                if (index <= (liveIndexes[sessionId] ?: -1L)) return
                liveIndexes[sessionId] = index
                val deltaText = item["text"]?.jsonPrimitive?.content ?: ""
                val deltaReasoning = item["reasoning"]?.jsonPrimitive?.content ?: ""

                val overlayFlow = liveOverlays.computeIfAbsent(sessionId) { MutableStateFlow(null) }
                val current = overlayFlow.value

                if (current != null && current.attempt == attempt) {
                    overlayFlow.value = current.copy(
                        text = (current.text + deltaText).takeLast(65_536),
                        reasoning = (current.reasoning + deltaReasoning).takeLast(65_536),
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
