package io.github.lottooss.remora.core.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

object SessionCodecs {

    fun parsePreview(elem: JsonElement?): Preview {
        if (elem !is JsonObject) return Preview(text = "")
        val text = elem["text"]?.jsonPrimitive?.content ?: ""
        val bytes = elem["bytes"]?.jsonPrimitive?.longOrNull ?: text.toByteArray().size.toLong()
        val truncated = elem["truncated"]?.jsonPrimitive?.booleanOrNull ?: false
        return Preview(text = text, bytes = bytes, truncated = truncated)
    }

    fun parseModelRef(elem: JsonElement?): ModelRef? {
        if (elem !is JsonObject) return null
        val provider = elem["provider"]?.jsonPrimitive?.content ?: return null
        val model = elem["model"]?.jsonPrimitive?.content ?: return null
        val reasoning = elem["reasoningEffort"]?.jsonPrimitive?.content
        return ModelRef(provider = provider, model = model, reasoningEffort = reasoning)
    }

    fun parseSessionSummary(obj: JsonObject): SessionSummary {
        val id = obj["id"]?.jsonPrimitive?.content ?: ""
        val title = obj["title"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
        val status = obj["status"]?.jsonPrimitive?.content ?: "idle"
        val updatedAt = obj["updatedAt"]?.jsonPrimitive?.longOrNull ?: 0L
        val parentId = obj["parentId"]?.jsonPrimitive?.content
        val archived = obj["archived"]?.jsonPrimitive?.booleanOrNull ?: false
        val model = parseModelRef(obj["model"])

        val wsObj = obj["workspace"]?.jsonObject
        val workspace = if (wsObj != null) {
            WorkspaceRef(
                id = wsObj["id"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                path = wsObj["path"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
                title = wsObj["title"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content,
            )
        } else {
            WorkspaceRef()
        }

        return SessionSummary(
            id = id,
            title = title,
            workspace = workspace,
            status = status,
            updatedAt = updatedAt,
            model = model,
            parentId = parentId,
            archived = archived,
        )
    }

    fun parseSessionEvent(obj: JsonObject): SessionEvent {
        val seq = obj["seq"]?.jsonPrimitive?.longOrNull ?: 0L
        val at = obj["at"]?.jsonPrimitive?.longOrNull ?: 0L
        val kind = obj["kind"]?.jsonPrimitive?.content ?: "unknown"

        return when (kind) {
            "user.message" -> {
                val text = obj["text"]?.jsonPrimitive?.content ?: ""
                val source = obj["source"]?.jsonPrimitive?.content ?: "user"
                val reqId = obj["requestId"]?.jsonPrimitive?.content
                SessionEvent.UserMessage(seq = seq, at = at, text = text, source = source, requestId = reqId)
            }
            "assistant.message" -> {
                val text = obj["text"]?.jsonPrimitive?.content ?: ""
                val reasoning = obj["reasoning"]?.jsonPrimitive?.content
                val model = parseModelRef(obj["model"])
                SessionEvent.AssistantMessage(seq = seq, at = at, text = text, reasoning = reasoning, model = model)
            }
            "assistant.attempt" -> {
                val outcome = obj["outcome"]?.jsonPrimitive?.content ?: "unknown"
                val text = obj["text"]?.jsonPrimitive?.content
                SessionEvent.AssistantAttempt(seq = seq, at = at, outcome = outcome, text = text)
            }
            "tool.call" -> {
                val callId = obj["callId"]?.jsonPrimitive?.content ?: ""
                val tool = obj["tool"]?.jsonPrimitive?.content ?: ""
                val title = obj["title"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content ?: ""
                val args = parsePreview(obj["args"])
                SessionEvent.ToolCall(seq = seq, at = at, callId = callId, tool = tool, title = title, args = args)
            }
            "tool.result" -> {
                val callId = obj["callId"]?.jsonPrimitive?.content ?: ""
                val status = obj["status"]?.jsonPrimitive?.content ?: "ok"
                val output = parsePreview(obj["output"])
                SessionEvent.ToolResult(seq = seq, at = at, callId = callId, status = status, output = output)
            }
            "turn.start" -> SessionEvent.TurnStart(seq = seq, at = at)
            "turn.end" -> {
                val status = obj["status"]?.jsonPrimitive?.content ?: "completed"
                val error = obj["error"]?.jsonPrimitive?.content
                SessionEvent.TurnEnd(seq = seq, at = at, status = status, error = error)
            }
            "approval.decided" -> {
                val tool = obj["toolName"]?.jsonPrimitive?.content ?: ""
                val callId = obj["callId"]?.jsonPrimitive?.content
                val outcome = obj["outcome"]?.jsonPrimitive?.content ?: "allowed-once"
                SessionEvent.ApprovalDecided(seq = seq, at = at, toolName = tool, callId = callId, outcome = outcome)
            }
            "todo.updated" -> {
                val itemsArr = obj["items"]?.jsonArray ?: JsonArray(emptyList())
                val items = itemsArr.mapNotNull {
                    if (it is JsonObject) {
                        SessionEvent.TodoItem(
                            text = it["text"]?.jsonPrimitive?.content ?: "",
                            status = it["status"]?.jsonPrimitive?.content ?: "pending",
                        )
                    } else null
                }
                SessionEvent.TodoUpdated(seq = seq, at = at, items = items)
            }
            "notice" -> {
                val level = obj["level"]?.jsonPrimitive?.content ?: "info"
                val text = obj["text"]?.jsonPrimitive?.content ?: ""
                SessionEvent.Notice(seq = seq, at = at, level = level, text = text)
            }
            else -> {
                val dshType = obj["dshType"]?.jsonPrimitive?.content ?: kind
                SessionEvent.Unknown(seq = seq, at = at, dshType = dshType)
            }
        }
    }
}
