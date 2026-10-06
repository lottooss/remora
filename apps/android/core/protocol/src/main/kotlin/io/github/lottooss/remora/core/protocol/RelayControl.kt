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

/** Normative RLY/1 §5 bounds shared by the control-frame validators. */
const val MAX_RID_LENGTH: Int = 32
const val MAX_PUSH_CT_LENGTH: Int = 3_072
val PUSH_STATUSES: Set<String> = setOf("sent", "no_token", "unregistered", "error")

@Serializable
data class PeerInfo(
    val id: String,
    val kind: String,
    val name: String,
    val online: Boolean,
    val lastSeenAt: Long,
) {
    init {
        require(kind == "host" || kind == "device") { "peer kind must be host or device" }
        require(lastSeenAt >= 0) { "lastSeenAt must be non-negative" }
    }
}

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
    ) : ControlFrame {
        init {
            require(v == 1) { "unsupported RLY version: $v" }
            require(time >= 0) { "time must be non-negative" }
        }
    }

    @Serializable
    @SerialName("auth")
    data class Auth(
        val v: Int = 1,
        val kind: String,
        val id: String,
        val sig: String,
        val app: String? = null,
    ) : ControlFrame {
        init {
            require(v == 1) { "unsupported RLY version: $v" }
            require(kind == "host" || kind == "device") { "auth kind must be host or device" }
        }
    }

    @Serializable
    @SerialName("ready")
    data class Ready(
        val v: Int = 1,
        val id: String,
        val peers: List<PeerInfo> = emptyList(),
        val limits: JsonObject? = null,
    ) : ControlFrame {
        init {
            require(v == 1) { "unsupported RLY version: $v" }
        }
    }

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
    ) : ControlFrame {
        init {
            require(kind == "host" || kind == "device") { "presence kind must be host or device" }
            require(at >= 0) { "at must be non-negative" }
        }
    }

    @Serializable
    @SerialName("enroll.ticket")
    data class EnrollTicketRequest(
        val rid: String,
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("enroll.ticket.ok")
    data class EnrollTicketResponse(
        val rid: String,
        val ticket: String,
        val expiresAt: Long,
    ) : ControlFrame {
        init {
            require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" }
            require(expiresAt >= 0) { "expiresAt must be non-negative" }
        }
    }

    @Serializable
    @SerialName("endpoint.list")
    data class EndpointListRequest(
        val rid: String,
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("endpoint.list.ok")
    data class EndpointListResponse(
        val rid: String,
        val devices: List<PeerInfo> = emptyList(),
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("endpoint.revoke")
    data class EndpointRevokeRequest(
        val rid: String,
        val id: String,
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("push")
    data class PushRequest(
        val rid: String,
        val to: List<String>,
        val ct: String,
        val collapse: String? = null,
        val priority: String = "normal",
        val ttl: Int = 86400,
    ) : ControlFrame {
        init {
            require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" }
            require(priority == "high" || priority == "normal") { "push priority must be high or normal" }
            require(ttl in 0..86_400) { "push ttl must be 0..86400 seconds" }
            require(ct.length <= MAX_PUSH_CT_LENGTH) { "push ct above 3072 characters" }
        }
    }

    @Serializable
    data class PushResultItem(
        val id: String,
        val status: String,
    ) {
        init {
            require(status in PUSH_STATUSES) { "push status outside the documented set" }
        }
    }

    @Serializable
    @SerialName("push.result")
    data class PushResponse(
        val rid: String,
        val results: List<PushResultItem> = emptyList(),
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("push.token")
    data class PushTokenRequest(
        val rid: String,
        val token: String,
        val hostOffline: Boolean,
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("bye")
    data class Bye(
        val reason: String? = null,
    ) : ControlFrame

    @Serializable
    @SerialName("ok")
    data class Ok(
        val rid: String,
    ) : ControlFrame {
        init { require(rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }

    @Serializable
    @SerialName("error")
    data class Error(
        val rid: String? = null,
        val code: String,
        val message: String,
        val ref: String? = null,
    ) : ControlFrame {
        init { require(rid == null || rid.length <= MAX_RID_LENGTH) { "rid above 32 characters" } }
    }
}

val RelayJson = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
}
