package io.github.lottooss.remora.core.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject

class RcpException(message: String) : RuntimeException(message)

object RcpErrorCodes {
    const val INVALID_REQUEST: String = "invalid_request"
    const val METHOD_NOT_FOUND: String = "method_not_found"
    const val INVALID_PARAMS: String = "invalid_params"
    const val UNAUTHORIZED: String = "unauthorized"
    const val FORBIDDEN: String = "forbidden"
    const val NOT_FOUND: String = "not_found"
    const val CONFLICT: String = "conflict"
    const val RATE_LIMITED: String = "rate_limited"
    const val TOO_LARGE: String = "too_large"
    const val CANCELLED: String = "cancelled"
    const val INTERNAL_ERROR: String = "internal_error"
}

@Serializable
data class RcpError(
    val code: String,
    val message: String,
    val retryAfterMs: Long? = null,
    val details: JsonObject? = null,
) {
    init {
        require(code.isNotEmpty()) { "error code must not be empty" }
        if (retryAfterMs != null) {
            require(retryAfterMs >= 0) { "retryAfterMs must be non-negative" }
        }
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("k")
sealed interface RcpMessage {

    @Serializable
    @SerialName("req")
    data class Request(
        val id: Long,
        val m: String,
        val p: JsonObject? = null,
    ) : RcpMessage {
        init {
            require(id in 0..0xffffffffL) { "id must be u32 (0..4294967295)" }
            require(m.isNotEmpty()) { "method name must not be empty" }
        }
    }

    @Serializable
    @SerialName("res")
    data class Response(
        val id: Long,
        val ok: Boolean,
        val r: JsonObject? = null,
        val e: RcpError? = null,
    ) : RcpMessage {
        init {
            require(id in 0..0xffffffffL) { "id must be u32 (0..4294967295)" }
            if (ok) {
                require(e == null) { "'e' is not allowed when 'ok' is true" }
            } else {
                require(e != null) { "'e' is required when 'ok' is false" }
                require(r == null) { "'r' is not allowed when 'ok' is false" }
            }
        }
    }

    @Serializable
    @SerialName("item")
    data class StreamItem(
        val sid: Long,
        val n: Long,
        val d: JsonObject,
    ) : RcpMessage {
        init {
            require(sid in 0..0xffffffffL) { "sid must be u32" }
            require(n >= 0) { "n must be non-negative" }
        }
    }

    @Serializable
    @SerialName("end")
    data class StreamEnd(
        val sid: Long,
        val ok: Boolean,
        val e: RcpError? = null,
    ) : RcpMessage {
        init {
            require(sid in 0..0xffffffffL) { "sid must be u32" }
        }
    }

    @Serializable
    @SerialName("cancel")
    data class StreamCancel(
        val sid: Long,
    ) : RcpMessage {
        init {
            require(sid in 0..0xffffffffL) { "sid must be u32" }
        }
    }

    @Serializable
    @SerialName("evt")
    data class Event(
        val e: String,
        val d: JsonObject,
    ) : RcpMessage {
        init {
            require(e.isNotEmpty()) { "event name must not be empty" }
        }
    }
}

val RcpJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
}

fun encodeRcpMessage(message: RcpMessage): String {
    val text = RcpJson.encodeToString(RcpMessage.serializer(), message)
    val byteCount = text.toByteArray(Charsets.UTF_8).size
    if (byteCount > Limits.MAX_RCP_MESSAGE_BYTES) {
        throw RcpException("RCP message size ($byteCount bytes) exceeds limit (${Limits.MAX_RCP_MESSAGE_BYTES})")
    }
    return text
}

fun decodeRcpMessage(text: String): RcpMessage {
    val byteCount = text.toByteArray(Charsets.UTF_8).size
    if (byteCount > Limits.MAX_RCP_MESSAGE_BYTES) {
        throw RcpException("RCP message size ($byteCount bytes) exceeds limit (${Limits.MAX_RCP_MESSAGE_BYTES})")
    }
    return try {
        RcpJson.decodeFromString(RcpMessage.serializer(), text)
    } catch (e: Exception) {
        throw RcpException("Invalid RCP envelope: ${e.message}")
    }
}
