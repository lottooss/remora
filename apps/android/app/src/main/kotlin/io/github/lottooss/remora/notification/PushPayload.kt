package io.github.lottooss.remora.notification

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

enum class PushKind { APPROVAL, QUESTION, TURN_DONE, TURN_ERROR }

enum class RemoraNotificationChannel { APPROVALS, QUESTIONS, TURNS, ERRORS, HOST_OFFLINE }

data class PushPayload(
    val version: Int,
    val kind: PushKind,
    val title: String,
    val body: String,
    val sessionId: String? = null,
    val pendingId: String? = null,
)

fun parsePushPayload(json: String): PushPayload? {
    return try {
        val obj = Json.parseToJsonElement(json).jsonObject
        val version = obj["v"]?.jsonPrimitive?.int ?: return null
        if (version != 1 || json.toByteArray().size > 2_048) return null
        val kindStr = obj["kind"]?.jsonPrimitive?.contentOrNull ?: return null
        val kind = when (kindStr) {
            "approval" -> PushKind.APPROVAL
            "question" -> PushKind.QUESTION
            "turn_done" -> PushKind.TURN_DONE
            "turn_error" -> PushKind.TURN_ERROR
            else -> return null
        }
        val title = obj["title"]?.jsonPrimitive?.contentOrNull ?: return null
        val body = obj["body"]?.jsonPrimitive?.contentOrNull ?: return null
        val sessionId = obj["sessionId"]?.jsonPrimitive?.contentOrNull
        val pendingId = obj["pendingId"]?.jsonPrimitive?.contentOrNull
        PushPayload(version, kind, title, body, sessionId, pendingId)
    } catch (_: Exception) {
        null
    }
}

fun channelForKind(kind: PushKind): RemoraNotificationChannel = when (kind) {
    PushKind.APPROVAL -> RemoraNotificationChannel.APPROVALS
    PushKind.QUESTION -> RemoraNotificationChannel.QUESTIONS
    PushKind.TURN_DONE -> RemoraNotificationChannel.TURNS
    PushKind.TURN_ERROR -> RemoraNotificationChannel.ERRORS
}

/** Every action link binds its paired host; an unbound legacy payload goes to host selection. */
fun deepLinkForPayload(payload: PushPayload, hostId: String? = null): String {
    if (hostId == null || !hostId.matches(Regex("h_[a-z2-7]{26}"))) return "remora://hosts"
    val base = "remora://host/$hostId"
    return when (payload.kind) {
        PushKind.APPROVAL -> "$base/approvals"
        PushKind.QUESTION, PushKind.TURN_DONE, PushKind.TURN_ERROR -> payload.sessionId?.takeIf { it.isNotBlank() }?.let {
            "$base/session/${java.net.URLEncoder.encode(it, "UTF-8").replace("+", "%20")}" 
        } ?: "remora://hosts"
    }
}
