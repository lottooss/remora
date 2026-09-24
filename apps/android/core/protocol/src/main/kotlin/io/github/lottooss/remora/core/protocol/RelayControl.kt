package io.github.lottooss.remora.core.protocol

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonObject

object CloseCodes {
    const val NORMAL: Int = 1000
    const val MALFORMED: Int = 4400
    const val AUTH_FAILED: Int = 4401
    const val FORBIDDEN: Int = 4403
    const val NOT_FOUND: Int = 4404
    const val AUTH_TIMEOUT: Int = 4408
    const val CLIENT_REPLACED: Int = 4409
    const val RATE_LIMITED: Int = 4429
}

object RelayErrorCodes {
    const val BAD_REQUEST: String = "bad_request"
    const val UNAUTHORIZED: String = "unauthorized"
    const val FORBIDDEN: String = "forbidden"
    const val NOT_FOUND: String = "not_found"
    const val NOT_LINKED: String = "not_linked"
    const val PEER_OFFLINE: String = "peer_offline"
    const val RATE_LIMITED: String = "rate_limited"
    const val TOO_LARGE: String = "too_large"
    const val TICKET_INVALID: String = "ticket_invalid"
    const val INTERNAL_ERROR: String = "internal_error"
}

@Serializable
data class PeerInfo(
    val id: String,
    val kind: String,
    val name: String,
    val online: Boolean,
    val lastSeenAt: Long,
)

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("t")
sealed interface ControlFrame {

    @Serializable
    @SerialName("challenge")
    data class Challenge(
        val v: Int = 1,
        val nonce: String,
        val time: Long,
    ) : ControlFrame

    @Serializable
    @SerialName("auth")
    data class Auth(
        val v: Int = 1,
        val kind: String,
        val id: String,
        val sig: String,
        val app: String? = null,
    ) : ControlFrame

    @Serializable
    @SerialName("ready")
    data class Ready(
        val v: Int = 1,
        val id: String,
        val peers: List<PeerInfo> = emptyList(),
        val limits: JsonObject? = null,
    ) : ControlFrame

    @Serializable
    @SerialName("ping")
    data class Ping(val unused: String? = null) : ControlFrame

    @Serializable
    @SerialName("pong")
    data class Pong(val unused: String? = null) : ControlFrame

    @Serializable
    @SerialName("presence")
    data class Presence(
        val id: String,
        val kind: String,
        val online: Boolean,
        val at: Long,
    ) : ControlFrame

    @Serializable
    @SerialName("enroll.ticket")
    data class EnrollTicketRequest(
        val rid: String,
    ) : ControlFrame

    @Serializable
    @SerialName("enroll.ticket.ok")
    data class EnrollTicketResponse(
        val rid: String,
        val ticket: String,
        val expiresAt: Long,
    ) : ControlFrame

    @Serializable
    @SerialName("endpoint.list")
    data class EndpointListRequest(
        val rid: String,
    ) : ControlFrame

    @Serializable
    @SerialName("endpoint.list.ok")
    data class EndpointListResponse(
        val rid: String,
        val devices: List<PeerInfo> = emptyList(),
    ) : ControlFrame

    @Serializable
    @SerialName("endpoint.revoke")
    data class EndpointRevokeRequest(
        val rid: String,
        val id: String,
    ) : ControlFrame

    @Serializable
    @SerialName("push")
    data class PushRequest(
        val rid: String,
        val to: List<String>,
        val ct: String,
        val collapse: String? = null,
        val priority: String = "normal",
        val ttl: Int = 86400,
    ) : ControlFrame

    @Serializable
    data class PushResultItem(
        val id: String,
        val status: String,
    )

    @Serializable
    @SerialName("push.result")
    data class PushResponse(
        val rid: String,
        val results: List<PushResultItem> = emptyList(),
    ) : ControlFrame

    @Serializable
    @SerialName("push.token")
    data class PushTokenRequest(
        val rid: String,
        val token: String,
        val hostOffline: Boolean,
    ) : ControlFrame

    @Serializable
    @SerialName("bye")
    data class Bye(
        val reason: String? = null,
    ) : ControlFrame

    @Serializable
    @SerialName("ok")
    data class Ok(
        val rid: String,
    ) : ControlFrame

    @Serializable
    @SerialName("error")
    data class Error(
        val rid: String? = null,
        val code: String,
        val message: String,
        val ref: String? = null,
    ) : ControlFrame
}

val RelayJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
}
