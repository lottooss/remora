package io.github.lottooss.remora.core.protocol

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

@Serializable
data class Preview(
    val text: String,
    val bytes: Long? = null,
    val truncated: Boolean? = null,
)

@Serializable
data class ModelRef(
    val provider: String,
    val model: String,
)

@Serializable(with = SessionStatusSerializer::class)
enum class SessionStatus(val wireName: String) {
    IDLE("idle"),
    RUNNING("running"),
    ERROR("error"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String?): SessionStatus = when (value) {
            "idle" -> IDLE
            "running" -> RUNNING
            "error" -> ERROR
            else -> UNKNOWN
        }
    }
}

object SessionStatusSerializer : KSerializer<SessionStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("SessionStatus", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: SessionStatus) = encoder.encodeString(value.wireName)
    override fun deserialize(decoder: Decoder): SessionStatus = SessionStatus.fromWire(decoder.decodeString())
}

@Serializable(with = TurnEndStatusSerializer::class)
enum class TurnEndStatus(val wireName: String) {
    COMPLETED("completed"),
    CANCELLED("cancelled"),
    ERROR("error"),
    INTERRUPTED("interrupted"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String?): TurnEndStatus = when (value) {
            "completed" -> COMPLETED
            "cancelled" -> CANCELLED
            "error" -> ERROR
            "interrupted" -> INTERRUPTED
            else -> UNKNOWN
        }
    }
}

object TurnEndStatusSerializer : KSerializer<TurnEndStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("TurnEndStatus", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: TurnEndStatus) = encoder.encodeString(value.wireName)
    override fun deserialize(decoder: Decoder): TurnEndStatus = TurnEndStatus.fromWire(decoder.decodeString())
}

@Serializable(with = ToolResultStatusSerializer::class)
enum class ToolResultStatus(val wireName: String) {
    OK("ok"),
    ERROR("error"),
    DENIED("denied"),
    CANCELLED("cancelled"),
    TIMEOUT("timeout"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String?): ToolResultStatus = when (value) {
            "ok" -> OK
            "error" -> ERROR
            "denied" -> DENIED
            "cancelled" -> CANCELLED
            "timeout" -> TIMEOUT
            else -> UNKNOWN
        }
    }
}

object ToolResultStatusSerializer : KSerializer<ToolResultStatus> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("ToolResultStatus", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ToolResultStatus) = encoder.encodeString(value.wireName)
    override fun deserialize(decoder: Decoder): ToolResultStatus = ToolResultStatus.fromWire(decoder.decodeString())
}

@Serializable(with = ApprovalRiskSerializer::class)
enum class ApprovalRisk(val wireName: String) {
    NORMAL("normal"),
    HIGH("high");

    companion object {
        fun fromWire(value: String?): ApprovalRisk = when (value) {
            "normal" -> NORMAL
            else -> HIGH // Fail closed / conservative
        }
    }
}

object ApprovalRiskSerializer : KSerializer<ApprovalRisk> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("ApprovalRisk", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ApprovalRisk) = encoder.encodeString(value.wireName)
    override fun deserialize(decoder: Decoder): ApprovalRisk = ApprovalRisk.fromWire(decoder.decodeString())
}

@Serializable(with = ApprovalOutcomeSerializer::class)
enum class ApprovalOutcome(val wireName: String) {
    ALLOWED_ONCE("allowed-once"),
    REJECTED("rejected"),
    CANCELLED("cancelled"),
    UNAVAILABLE("unavailable"),
    UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String?): ApprovalOutcome = when (value) {
            "allowed-once" -> ALLOWED_ONCE
            "rejected" -> REJECTED
            "cancelled" -> CANCELLED
            "unavailable" -> UNAVAILABLE
            else -> UNKNOWN
        }
    }
}

object ApprovalOutcomeSerializer : KSerializer<ApprovalOutcome> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("ApprovalOutcome", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: ApprovalOutcome) = encoder.encodeString(value.wireName)
    override fun deserialize(decoder: Decoder): ApprovalOutcome = ApprovalOutcome.fromWire(decoder.decodeString())
}

@Serializable(with = SessionEventSerializer::class)
sealed interface SessionEvent {
    val seq: Long
    val at: Long
    val kind: String

    @Serializable
    @SerialName("session.created")
    data class SessionCreated(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "session.created",
        val sessionId: String,
    ) : SessionEvent

    @Serializable
    @SerialName("session.status")
    data class SessionStatusEvent(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "session.status",
        val sessionId: String,
        val status: SessionStatus = SessionStatus.UNKNOWN,
    ) : SessionEvent

    @Serializable
    @SerialName("turn.start")
    data class TurnStart(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "turn.start",
    ) : SessionEvent

    @Serializable
    @SerialName("turn.end")
    data class TurnEnd(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "turn.end",
        val status: TurnEndStatus = TurnEndStatus.UNKNOWN,
        val error: String? = null,
    ) : SessionEvent

    @Serializable
    @SerialName("agent.error")
    data class AgentError(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "agent.error",
        val message: String,
        val code: String? = null,
    ) : SessionEvent

    @Serializable
    @SerialName("assistant.message")
    data class AssistantMessage(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "assistant.message",
        val text: String,
        val reasoning: String? = null,
        val model: ModelRef? = null,
    ) : SessionEvent

    @Serializable
    @SerialName("assistant.delta")
    data class AssistantDelta(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "assistant.delta",
        val index: Int,
        val text: String? = null,
        val reasoning: String? = null,
        val attempt: String? = null,
    ) : SessionEvent

    @Serializable
    @SerialName("tool.call")
    data class ToolCall(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "tool.call",
        val callId: String,
        val tool: String,
        val title: String,
        val args: Preview,
    ) : SessionEvent

    @Serializable
    @SerialName("tool.result")
    data class ToolResult(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "tool.result",
        val callId: String,
        val status: ToolResultStatus = ToolResultStatus.UNKNOWN,
        val output: Preview,
    ) : SessionEvent

    @Serializable
    @SerialName("approval.asked")
    data class ApprovalAsked(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "approval.asked",
        val id: String,
        val toolName: String,
        val callId: String? = null,
        val risk: ApprovalRisk = ApprovalRisk.HIGH,
    ) : SessionEvent

    @Serializable
    @SerialName("approval.decided")
    data class ApprovalDecided(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "approval.decided",
        val toolName: String,
        val callId: String? = null,
        val outcome: ApprovalOutcome = ApprovalOutcome.UNKNOWN,
    ) : SessionEvent

    @Serializable
    @SerialName("question.asked")
    data class QuestionAsked(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "question.asked",
        val id: String,
        val text: String,
    ) : SessionEvent

    @Serializable
    @SerialName("question.decided")
    data class QuestionDecided(
        override val seq: Long,
        override val at: Long,
        override val kind: String = "question.decided",
        val id: String,
        val outcome: String,
        val by: String? = null,
    ) : SessionEvent

    @Serializable
    data class Unknown(
        override val seq: Long = 0,
        override val at: Long = 0,
        override val kind: String = "unknown",
        val dshType: String,
        val payload: JsonObject = JsonObject(emptyMap()),
    ) : SessionEvent
}

object SessionEventSerializer : JsonContentPolymorphicSerializer<SessionEvent>(SessionEvent::class) {
    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<SessionEvent> {
        val obj = element.jsonObject
        val kind = obj["kind"]?.jsonPrimitive?.contentOrNull
        return when (kind) {
            "session.created" -> SessionEvent.SessionCreated.serializer()
            "session.status" -> SessionEvent.SessionStatusEvent.serializer()
            "turn.start" -> SessionEvent.TurnStart.serializer()
            "turn.end" -> SessionEvent.TurnEnd.serializer()
            "agent.error" -> SessionEvent.AgentError.serializer()
            "assistant.message" -> SessionEvent.AssistantMessage.serializer()
            "assistant.delta" -> SessionEvent.AssistantDelta.serializer()
            "tool.call" -> SessionEvent.ToolCall.serializer()
            "tool.result" -> SessionEvent.ToolResult.serializer()
            "approval.asked" -> SessionEvent.ApprovalAsked.serializer()
            "approval.decided" -> SessionEvent.ApprovalDecided.serializer()
            "question.asked" -> SessionEvent.QuestionAsked.serializer()
            "question.decided" -> SessionEvent.QuestionDecided.serializer()
            "unknown" -> SessionEvent.Unknown.serializer()
            else -> SessionEventUnknownFallbackSerializer
        }
    }
}

object SessionEventUnknownFallbackSerializer : KSerializer<SessionEvent.Unknown> {
    override val descriptor: SerialDescriptor = JsonObject.serializer().descriptor

    override fun serialize(encoder: Encoder, value: SessionEvent.Unknown) {
        SessionEvent.Unknown.serializer().serialize(encoder, value)
    }

    override fun deserialize(decoder: Decoder): SessionEvent.Unknown {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw IllegalStateException("SessionEvent unknown fallback requires JsonDecoder")
        val obj = jsonDecoder.decodeJsonElement().jsonObject
        val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: "unknown"
        val seq = obj["seq"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        val at = obj["at"]?.jsonPrimitive?.contentOrNull?.toLongOrNull() ?: 0L
        return SessionEvent.Unknown(
            seq = seq,
            at = at,
            kind = "unknown",
            dshType = kind,
            payload = obj,
        )
    }
}
