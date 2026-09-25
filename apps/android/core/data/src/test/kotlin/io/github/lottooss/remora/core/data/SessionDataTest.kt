package io.github.lottooss.remora.core.data

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class SessionDataTest {

    @Test
    fun testSessionRepositoryBoundingAndPruning() {
        val repo = SessionRepository(maxEventsPerSession = 10)
        val sId = "s_test_123"

        // Append 15 events
        val events = (1L..15L).map { seq ->
            SessionEvent.UserMessage(seq = seq, at = 1000L + seq, text = "Msg $seq")
        }

        repo.appendEvents(sId, events)

        val stored = repo.getEvents(sId)
        // Must be capped at exactly maxEventsPerSession = 10
        assertThat(stored).hasSize(10)
        // Should keep newest events (6 to 15)
        assertThat(stored.first().seq).isEqualTo(6L)
        assertThat(stored.last().seq).isEqualTo(15L)
        assertThat(repo.hasOlder(sId)).isTrue()
        assertThat(repo.getHighestSeq(sId)).isEqualTo(15L)
        assertThat(repo.getLowestSeq(sId)).isEqualTo(6L)
    }

    @Test
    fun testSessionRepositoryDeduplication() {
        val repo = SessionRepository()
        val sId = "s_dedup"

        val event1 = SessionEvent.UserMessage(seq = 1L, at = 100L, text = "First")
        val event2 = SessionEvent.TurnStart(seq = 2L, at = 200L)
        val eventDuplicate = SessionEvent.UserMessage(seq = 1L, at = 100L, text = "Duplicate")

        repo.appendEvents(sId, listOf(event1, event2))
        repo.appendEvents(sId, listOf(eventDuplicate))

        val stored = repo.getEvents(sId)
        assertThat(stored).hasSize(2)
        assertThat(stored.map { it.seq }).containsExactly(1L, 2L).inOrder()
    }

    @Test
    fun testSessionCodecsParseAllEventKinds() {
        val userMsgJson = buildJsonObject {
            put("seq", 1)
            put("at", 100)
            put("kind", "user.message")
            put("text", "hello")
            put("source", "user")
        }
        val userMsg = SessionCodecs.parseSessionEvent(userMsgJson)
        assertThat(userMsg).isInstanceOf(SessionEvent.UserMessage::class.java)
        assertThat((userMsg as SessionEvent.UserMessage).text).isEqualTo("hello")

        val toolCallJson = buildJsonObject {
            put("seq", 2)
            put("at", 200)
            put("kind", "tool.call")
            put("callId", "call_1")
            put("tool", "bash")
            put("title", "Run command")
            put("args", buildJsonObject {
                put("text", "ls -la")
                put("bytes", 6)
                put("truncated", false)
            })
        }
        val toolCall = SessionCodecs.parseSessionEvent(toolCallJson)
        assertThat(toolCall).isInstanceOf(SessionEvent.ToolCall::class.java)
        val tc = toolCall as SessionEvent.ToolCall
        assertThat(tc.tool).isEqualTo("bash")
        assertThat(tc.args.text).isEqualTo("ls -la")

        val toolResultJson = buildJsonObject {
            put("seq", 3)
            put("at", 300)
            put("kind", "tool.result")
            put("callId", "call_1")
            put("status", "ok")
            put("output", buildJsonObject {
                put("text", "file.txt")
            })
        }
        val toolResult = SessionCodecs.parseSessionEvent(toolResultJson)
        assertThat(toolResult).isInstanceOf(SessionEvent.ToolResult::class.java)
        assertThat((toolResult as SessionEvent.ToolResult).status).isEqualTo("ok")
    }

    @Test
    fun testSyncEngineLiveDeltaAndSettlement() {
        val repo = SessionRepository()
        val syncEngine = SyncEngine(repo)
        val sId = "s_live_flow"

        // 1. live.start
        syncEngine.handleFollowItem(sId, buildJsonObject {
            put("type", "live.start")
            put("attempt", "att_1")
            put("afterSeq", 0)
        })

        var overlay = syncEngine.getLiveOverlay(sId).value
        assertThat(overlay).isNotNull()
        assertThat(overlay!!.attempt).isEqualTo("att_1")

        // 2. live.delta (monotonically accumulates)
        syncEngine.handleFollowItem(sId, buildJsonObject {
            put("type", "live.delta")
            put("attempt", "att_1")
            put("index", 1)
            put("text", "Hello ")
            put("reasoning", "Thinking...")
        })
        syncEngine.handleFollowItem(sId, buildJsonObject {
            put("type", "live.delta")
            put("attempt", "att_1")
            put("index", 2)
            put("text", "world!")
        })

        overlay = syncEngine.getLiveOverlay(sId).value
        assertThat(overlay!!.text).isEqualTo("Hello world!")
        assertThat(overlay.reasoning).isEqualTo("Thinking...")

        // 3. Durable assistant.message settles the turn -> live overlay is retired
        syncEngine.handleFollowItem(sId, buildJsonObject {
            put("type", "events")
            put("events", buildJsonArray {
                add(buildJsonObject {
                    put("seq", 1)
                    put("at", 1500)
                    put("kind", "assistant.message")
                    put("text", "Hello world!")
                })
            })
        })

        overlay = syncEngine.getLiveOverlay(sId).value
        assertThat(overlay).isNull()
        assertThat(repo.getEvents(sId)).hasSize(1)
    }

    @Test
    fun testSyncEngineResetClearsSession() {
        val repo = SessionRepository()
        val syncEngine = SyncEngine(repo)
        val sId = "s_reset_test"

        repo.appendEvents(sId, listOf(
            SessionEvent.UserMessage(seq = 1, at = 100, text = "To be cleared")
        ))
        assertThat(repo.getEvents(sId)).isNotEmpty()

        syncEngine.handleFollowItem(sId, buildJsonObject {
            put("type", "reset")
            put("reason", "cursor_unavailable")
        })

        assertThat(repo.getEvents(sId)).isEmpty()
    }

    @Test
    fun testOfflinePolicyBlocksMutatingPrompt() = runBlocking {
        val repo = SessionRepository()
        val service = SessionService(repo)

        // Null rcpClient represents disconnected state
        val res = service.sendPrompt(rcpClient = null, sessionId = "s_test", text = "hello")
        assertThat(res.isFailure).isTrue()
        assertThat(res.exceptionOrNull()?.message).contains("disconnected")
    }
}
