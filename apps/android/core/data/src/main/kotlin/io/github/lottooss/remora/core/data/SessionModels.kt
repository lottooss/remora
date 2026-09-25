package io.github.lottooss.remora.core.data

import kotlinx.serialization.Serializable

@Serializable
data class WorkspaceRef(
    val id: String? = null,
    val path: String? = null,
    val title: String? = null,
)

@Serializable
data class ModelRef(
    val provider: String,
    val model: String,
    val reasoningEffort: String? = null,
)

@Serializable
data class Preview(
    val text: String,
    val bytes: Long = text.toByteArray().size.toLong(),
    val truncated: Boolean = false,
)

@Serializable
data class SessionSummary(
    val id: String,
    val title: String? = null,
    val workspace: WorkspaceRef = WorkspaceRef(),
    val status: String = "idle", // 'idle' | 'running' | 'error' | 'unknown'
    val updatedAt: Long = 0L,
    val model: ModelRef? = null,
    val parentId: String? = null,
    val archived: Boolean = false,
)

sealed interface SessionEvent {
    val seq: Long
    val at: Long
    val kind: String

    data class UserMessage(
        override val seq: Long,
        override val at: Long,
        val text: String,
        val source: String = "user",
        val requestId: String? = null,
    ) : SessionEvent {
        override val kind: String get() = "user.message"
    }

    data class AssistantMessage(
        override val seq: Long,
        override val at: Long,
        val text: String,
        val reasoning: String? = null,
        val model: ModelRef? = null,
    ) : SessionEvent {
        override val kind: String get() = "assistant.message"
    }

    data class AssistantAttempt(
        override val seq: Long,
        override val at: Long,
        val outcome: String,
        val text: String? = null,
    ) : SessionEvent {
        override val kind: String get() = "assistant.attempt"
    }

    data class ToolCall(
        override val seq: Long,
        override val at: Long,
        val callId: String,
        val tool: String,
        val title: String,
        val args: Preview,
    ) : SessionEvent {
        override val kind: String get() = "tool.call"
    }

    data class ToolResult(
        override val seq: Long,
        override val at: Long,
        val callId: String,
        val status: String, // 'ok' | 'error' | 'denied' | 'cancelled' | 'timeout' | 'unknown'
        val output: Preview,
    ) : SessionEvent {
        override val kind: String get() = "tool.result"
    }

    data class TurnStart(
        override val seq: Long,
        override val at: Long,
    ) : SessionEvent {
        override val kind: String get() = "turn.start"
    }

    data class TurnEnd(
        override val seq: Long,
        override val at: Long,
        val status: String,
        val error: String? = null,
    ) : SessionEvent {
        override val kind: String get() = "turn.end"
    }

    data class ApprovalDecided(
        override val seq: Long,
        override val at: Long,
        val toolName: String,
        val callId: String? = null,
        val outcome: String,
    ) : SessionEvent {
        override val kind: String get() = "approval.decided"
    }

    data class TodoItem(
        val text: String,
        val status: String,
    )

    data class TodoUpdated(
        override val seq: Long,
        override val at: Long,
        val items: List<TodoItem>,
    ) : SessionEvent {
        override val kind: String get() = "todo.updated"
    }

    data class Notice(
        override val seq: Long,
        override val at: Long,
        val level: String,
        val text: String,
    ) : SessionEvent {
        override val kind: String get() = "notice"
    }

    data class Unknown(
        override val seq: Long,
        override val at: Long,
        val dshType: String,
    ) : SessionEvent {
        override val kind: String get() = "unknown"
    }
}

data class LiveDeltaOverlay(
    val attempt: String,
    val text: String = "",
    val reasoning: String = "",
    val active: Boolean = true,
)

data class SearchResult(
    val sessionId: String,
    val title: String?,
    val snippet: String,
    val at: Long,
)

data class ControlQueueItem(
    val itemId: String,
    val text: String,
    val delivery: String,
)

data class ControlJob(
    val id: String,
    val title: String,
    val state: String,
)

data class ControlState(
    val sessionId: String,
    val running: Boolean,
    val queue: List<ControlQueueItem> = emptyList(),
    val jobs: List<ControlJob> = emptyList(),
)
