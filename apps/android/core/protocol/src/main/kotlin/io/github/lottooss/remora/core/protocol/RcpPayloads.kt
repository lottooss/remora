package io.github.lottooss.remora.core.protocol

import kotlinx.serialization.json.*
import kotlin.math.floor

/** Content-free validation failure; codes identify the boundary, never payload text. */
class RcpPayloadException(val code: String) : IllegalArgumentException(code)

data class RcpMethodMetadata(val name: String, val kind: String, val mutating: Boolean)

private typealias Rule = (JsonElement?) -> JsonElement?
private fun invalid(): Nothing = throw IllegalArgumentException("Invalid RCP value")
private fun text(min: Int = 0, max: Int = Int.MAX_VALUE, pattern: Regex? = null): Rule = { value ->
    val p = value as? JsonPrimitive ?: invalid()
    if (!p.isString || p.content.length !in min..max || pattern?.matches(p.content) == false) invalid()
    p
}
private fun number(min: Double = -Double.MAX_VALUE, max: Double = Double.MAX_VALUE, integer: Boolean = false): Rule = { value ->
    val p = value as? JsonPrimitive ?: invalid()
    val n = p.doubleOrNull ?: invalid()
    if (p.isString || !n.isFinite() || n < min || n > max || (integer && (floor(n) != n || kotlin.math.abs(n) > 9007199254740991.0))) invalid()
    p
}
private val boolean: Rule = { value ->
    val p = value as? JsonPrimitive ?: invalid()
    if (p.isString || p.booleanOrNull == null) invalid()
    p
}
private fun optional(rule: Rule): Rule = { if (it == null) null else rule(it) }
private fun nullable(rule: Rule): Rule = { if (it == JsonNull) JsonNull else rule(it) }
private fun array(rule: Rule): Rule = { value -> JsonArray((value as? JsonArray ?: invalid()).map { rule(it) ?: invalid() }) }
private fun obj(vararg fields: Pair<String, Rule>): Rule = { value ->
    val original = value as? JsonObject ?: invalid()
    val parsed = original.toMutableMap()
    for ((name, rule) in fields) {
        val result = rule(original[name])
        if (result == null) parsed.remove(name) else parsed[name] = result
    }
    JsonObject(parsed)
}
private fun values(vararg choices: String): Rule = { value ->
    val p = text()(value) as JsonPrimitive
    if (p.content !in choices) invalid()
    p
}
private fun literal(value: Boolean): Rule = { input -> if (boolean(input) != JsonPrimitive(value)) invalid(); input }
private fun literal(value: Int): Rule = { input -> if ((number()(input) as JsonPrimitive).double != value.toDouble()) invalid(); input }
private fun fallback(rule: Rule, default: String): Rule = { value ->
    try { rule(value) } catch (_: IllegalArgumentException) { JsonPrimitive(default) }
}
private fun union(vararg alternatives: Rule): Rule = { value ->
    var result: JsonElement? = null
    for (rule in alternatives) {
        try { result = rule(value); break } catch (_: IllegalArgumentException) { /* Try the next documented shape. */ }
    }
    result ?: invalid()
}
private fun tagged(key: String, variants: Map<String, Rule>): Rule = { value ->
    val tag = (value as? JsonObject)?.get(key) as? JsonPrimitive ?: invalid()
    if (!tag.isString) invalid()
    (variants[tag.content] ?: invalid())(value)
}

/** Kotlin twin of the existing TS method schemas; unknown fields remain available. */
object RcpPayloads {
    private val string = text()
    private val nonempty = text(1)
    private val count = number(0.0, 9007199254740991.0, true)
    private val u32 = number(0.0, 4294967295.0, true)
    private val uuid = text(pattern = Regex("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"))
    private val b64u = text(pattern = Regex("[A-Za-z0-9_-]+"))
    private val hostId = text(pattern = Regex("h_[A-Za-z0-9_-]+"))
    private val deviceId = text(pattern = Regex("d_[A-Za-z0-9_-]+"))
    private val model = obj("provider" to nonempty, "model" to nonempty, "reasoningEffort" to optional(string))
    private val preview = obj("text" to string, "bytes" to count, "truncated" to boolean)
    private val empty = obj()
    private val by = values("phone", "pc", "system")
    private val policy = obj("approvalBiometric" to values("high", "all", "never"), "allowRemoteSessionStart" to boolean)
    private val versions = obj("remora" to string, "dsh" to string)
    private val prefs = obj("approval" to boolean, "question" to boolean, "turnDone" to boolean, "turnError" to boolean)
    private val workspace = obj("id" to nonempty, "title" to string, "path" to string, "remoteAllowed" to boolean)
    private val session = obj(
        "id" to nonempty, "title" to nullable(string),
        "workspace" to obj("id" to nullable(nonempty), "path" to nullable(string), "title" to nullable(string)),
        "status" to fallback(values("idle", "running", "error", "unknown"), "unknown"),
        "updatedAt" to count, "model" to optional(model), "parentId" to optional(nonempty), "archived" to optional(boolean),
    )
    private val error = obj("code" to nonempty, "message" to string, "retryAfterMs" to optional(count), "details" to optional(empty))
    private fun event(kind: String, vararg fields: Pair<String, Rule>): Rule = obj("kind" to values(kind), "seq" to count, "at" to count, *fields)
    private val eventSchemas = mapOf(
        "session.created" to event("session.created", "sessionId" to nonempty),
        "session.status" to event("session.status", "sessionId" to nonempty, "status" to fallback(values("idle", "running", "error", "unknown"), "unknown")),
        "turn.start" to event("turn.start"),
        "turn.end" to event("turn.end", "status" to fallback(values("completed", "cancelled", "error", "interrupted", "unknown"), "unknown"), "error" to optional(string)),
        "agent.error" to event("agent.error", "message" to string, "code" to optional(string)),
        "user.message" to event("user.message", "text" to string, "source" to fallback(values("user", "agent", "system", "other"), "other"), "requestId" to optional(string), "attachments" to optional(array(obj("name" to string, "mime" to string)))),
        "assistant.message" to event("assistant.message", "text" to string, "reasoning" to optional(string), "model" to optional(model)),
        "assistant.attempt" to event("assistant.attempt", "outcome" to fallback(values("failed", "retried", "cancelled", "stream-error", "unknown"), "unknown"), "text" to optional(string)),
        "assistant.delta" to event("assistant.delta", "index" to count, "text" to optional(string), "reasoning" to optional(string), "attempt" to optional(string)),
        "tool.call" to event("tool.call", "callId" to nonempty, "tool" to nonempty, "title" to string, "args" to preview),
        "tool.result" to event("tool.result", "callId" to nonempty, "status" to fallback(values("ok", "error", "denied", "cancelled", "timeout", "unknown"), "unknown"), "output" to preview),
        "approval.asked" to event("approval.asked", "id" to uuid, "toolName" to nonempty, "callId" to optional(string), "risk" to fallback(values("normal", "high"), "high")),
        "approval.decided" to event("approval.decided", "toolName" to nonempty, "callId" to optional(string), "outcome" to fallback(values("allowed-once", "rejected", "cancelled", "unavailable", "unknown"), "unknown")),
        "question.asked" to event("question.asked", "id" to uuid, "text" to string),
        "question.decided" to event("question.decided", "id" to uuid, "outcome" to string, "by" to optional(by)),
        "todo.updated" to event("todo.updated", "items" to array(obj("text" to string, "status" to fallback(values("pending", "in_progress", "completed", "unknown"), "unknown")))),
        "notice" to event("notice", "level" to fallback(values("info", "warn", "error"), "info"), "text" to string),
        "unknown" to obj("kind" to values("unknown"), "dshType" to string),
    )
    private val sessionEvent: Rule = { value ->
        val raw = value as? JsonObject ?: invalid()
        val kind = nonempty(raw["kind"]) as JsonPrimitive
        val rule = eventSchemas[kind.content]
        if (rule != null) rule(raw) else JsonObject(raw + ("kind" to JsonPrimitive("unknown")) + ("dshType" to kind))
    }
    private val control = obj("sessionId" to nonempty, "running" to boolean,
        "queue" to array(obj("itemId" to nonempty, "text" to string, "delivery" to values("queue", "steer"))),
        "jobs" to array(obj("id" to nonempty, "title" to string, "state" to string)))
    private val pendingCommon = arrayOf("id" to uuid, "sessionId" to nonempty, "sessionTitle" to nullable(string), "createdAt" to count, "expiresAt" to count)
    private val pendingApproval = obj("kind" to values("approval"), *pendingCommon,
        "toolName" to nonempty, "callId" to optional(string), "reason" to optional(string),
        "preview" to obj("text" to string, "json" to string), "argsDigest" to nonempty,
        "risk" to values("normal", "high"), "requiresSignature" to boolean)
    private val pendingQuestion = obj("kind" to values("question"), *pendingCommon,
        "questions" to array(obj("id" to nonempty, "question" to string, "detail" to optional(string), "header" to optional(string),
            "options" to optional(array(obj("label" to string, "description" to optional(string)))), "multiSelect" to optional(boolean),
            "intent" to optional(obj("kind" to values("plan-review"), "approve" to string)))))
    private val pending = tagged("kind", mapOf("approval" to pendingApproval, "question" to pendingQuestion))
    private val streamOpen = obj("sid" to u32)
    private val followItem = tagged("type", mapOf(
        "snapshot" to obj("type" to values("snapshot"), "session" to session, "events" to array(sessionEvent), "hasOlder" to boolean),
        "events" to obj("type" to values("events"), "events" to array(sessionEvent)),
        "live.start" to obj("type" to values("live.start"), "attempt" to string, "afterSeq" to count),
        "live.delta" to obj("type" to values("live.delta"), "attempt" to string, "index" to count, "text" to optional(string), "reasoning" to optional(string)),
        "live.end" to obj("type" to values("live.end"), "attempt" to string, "outcome" to values("settled", "abandoned")),
        "reset" to obj("type" to values("reset"), "reason" to values("cursor_unavailable", "session_replaced")),
    ))
    private val controlItem = tagged("type", mapOf(
        "baseline" to obj("type" to values("baseline"), "sessions" to array(control)),
        "update" to obj("type" to values("update"), "session" to control),
        "removed" to obj("type" to values("removed"), "sessionId" to nonempty),
    ))
    private val workspaceItem = tagged("type", mapOf(
        "baseline" to obj("type" to values("baseline"), "workspaces" to array(workspace)),
        "upsert" to obj("type" to values("upsert"), "workspace" to workspace),
        "removed" to obj("type" to values("removed"), "id" to nonempty),
    ))
    private val interactionItem = tagged("type", mapOf(
        "baseline" to obj("type" to values("baseline"), "pending" to array(pending)),
        "requested" to obj("type" to values("requested"), "pending" to pending),
        "resolved" to obj("type" to values("resolved"), "id" to uuid, "outcome" to string, "by" to by, "deviceId" to optional(deviceId)),
    ))
    private val fileItem = tagged("type", mapOf("ready" to obj("type" to values("ready")), "changed" to obj("type" to values("changed"), "paths" to array(string))))
    private val pageLimit = optional(number(1.0, 100.0, true))
    private val textLimit = optional(number(1.0, 32768.0, true))
    private val fileParams = obj("sessionId" to nonempty, "path" to nonempty)
    private val sessionParams = obj("sessionId" to nonempty)
    private val entry = obj("name" to nonempty, "kind" to values("dir", "file", "link"))
    private val fileEntry = obj("name" to nonempty, "kind" to values("dir", "file", "link"), "bytes" to optional(count))
    private data class Definition(val metadata: RcpMethodMetadata, val params: Rule, val result: Rule, val item: Rule? = null)
    private fun method(name: String, params: Rule, result: Rule, mutating: Boolean = false, item: Rule? = null) =
        Definition(RcpMethodMetadata(name, if (item == null) "unary" else "stream", mutating), params, result, item)
    private val definitions = listOf(
        method("hello", obj("rcp" to array(count), "app" to obj("name" to values("remora-android", "remora-testkit"), "version" to nonempty, "build" to optional(number(integer = true)))),
            obj("rcp" to literal(1), "host" to obj("id" to hostId, "name" to string, "os" to values("win32", "darwin", "linux"), "pathSeparator" to values("\\", "/"), "versions" to versions),
                "features" to array(values("sessions", "interaction", "workspaces", "files", "diffs.git", "notify", "models")), "roots" to array(string), "policy" to policy,
                "limits" to obj("maxMessageBytes" to count, "maxStreams" to count), "time" to count)),
        method("ping", obj("t" to number()), obj("t" to number(), "hostTime" to count)),
        method("host.status", empty, obj("uptimeMs" to number(0.0), "agentsRunning" to count, "keepAwake" to boolean, "dsh" to obj("version" to string, "profile" to string))),
        method("sessions.list", obj("cursor" to optional(string), "limit" to pageLimit, "includeArchived" to optional(boolean)), obj("items" to array(session), "next" to optional(string))),
        method("sessions.search", obj("query" to text(1, 200)), obj("results" to array(obj("sessionId" to nonempty, "title" to nullable(string), "snippet" to string, "at" to count)))),
        method("sessions.follow", obj("sessionId" to nonempty, "afterSeq" to optional(count), "live" to optional(boolean)), streamOpen, item = followItem),
        method("sessions.page", obj("sessionId" to nonempty, "beforeSeq" to count, "limit" to pageLimit), obj("events" to array(sessionEvent), "hasOlder" to boolean)),
        method("sessions.eventText", obj("sessionId" to nonempty, "seq" to count, "offset" to count, "limit" to textLimit), obj("text" to string, "offset" to count, "eof" to boolean)),
        method("sessions.toolOutput", obj("sessionId" to nonempty, "callId" to nonempty, "offset" to count, "limit" to textLimit), obj("text" to string, "offset" to count, "total" to count, "eof" to boolean)),
        method("sessions.prompt", obj("sessionId" to nonempty, "requestId" to uuid, "text" to text(1, 32768), "delivery" to values("queue", "steer")), obj("accepted" to literal(true), "duplicate" to boolean), true),
        method("sessions.cancel", obj("sessionId" to nonempty, "requestId" to uuid), obj("requested" to literal(true)), true),
        method("sessions.queue.update", obj("sessionId" to nonempty, "itemId" to nonempty, "action" to values("edit", "remove", "steer"), "text" to optional(string), "requestId" to uuid), obj("ok" to literal(true)), true),
        method("sessions.create", obj("requestId" to uuid, "workspace" to union(obj("id" to nonempty), obj("path" to nonempty)), "model" to optional(model), "preset" to optional(string)), obj("sessionId" to nonempty, "workspaceId" to nonempty), true),
        method("sessions.rename", obj("sessionId" to nonempty, "title" to text(1, 120), "requestId" to uuid), obj("title" to string), true),
        method("sessions.selectModel", obj("sessionId" to nonempty, "model" to model, "requestId" to uuid), obj("model" to model), true),
        method("sessions.control", empty, streamOpen, item = controlItem),
        method("models.catalog", empty, obj("providers" to array(obj("id" to nonempty, "name" to string, "models" to array(obj("id" to nonempty, "name" to string, "reasoningEfforts" to optional(array(string)))))), "default" to optional(model))),
        method("workspaces.follow", empty, streamOpen, item = workspaceItem),
        method("workspaces.list", empty, obj("workspaces" to array(workspace))),
        method("workspaces.create", obj("path" to nonempty, "requestId" to uuid), obj("workspace" to workspace, "created" to boolean), true),
        method("fs.browse", obj("path" to optional(string)), obj("path" to nullable(string), "parent" to nullable(string), "entries" to array(entry), "truncated" to boolean)),
        method("fs.mkdir", obj("parent" to nonempty, "name" to { value -> val p = text(1,255)(value) as JsonPrimitive; if (p.content in listOf(".", "..") || p.content.contains('/') || p.content.contains('\\')) invalid(); p }, "requestId" to uuid), obj("path" to nonempty), true),
        method("devices.self", empty, obj("id" to deviceId, "name" to string, "pairedAt" to count, "approvalKey" to obj("hardwareBacked" to nullable(boolean)))),
        method("devices.unpair", obj("requestId" to uuid), obj("ok" to literal(true)), true),
        method("devices.rotateApprovalKey", obj("approvalPub" to b64u, "requestId" to uuid), obj("status" to values("pending_pc_confirmation")), true),
        method("interaction.follow", empty, streamOpen, item = interactionItem),
        method("approvals.answer", obj("id" to uuid, "outcome" to values("allowed-once", "rejected"), "argsDigest" to nonempty, "issuedAt" to count, "sig" to optional(b64u)), obj("accepted" to boolean, "final" to values("allowed-once", "rejected", "cancelled", "unavailable"), "by" to by), true),
        method("questions.answer", obj("id" to uuid, "answers" to array(obj("id" to nonempty, "selected" to array(string), "custom" to optional(string)))), obj("accepted" to boolean, "by" to by), true),
        method("files.list", fileParams, obj("path" to string, "entries" to array(fileEntry), "truncated" to boolean)),
        method("files.stat", fileParams, obj("path" to string, "bytes" to optional(count), "version" to string)),
        method("files.read", obj("sessionId" to nonempty, "path" to nonempty, "offset" to optional(number(1.0, 9007199254740991.0, true)), "limit" to optional(number(1.0,400.0,true))), obj("path" to string, "version" to string, "offset" to number(1.0,9007199254740991.0,true), "text" to string, "lines" to count, "eof" to boolean, "bytes" to optional(count))),
        method("files.changes", sessionParams, streamOpen, item = fileItem),
        method("diffs.status", sessionParams, obj("source" to values("git", "session"), "branch" to optional(string), "files" to array(obj("path" to string, "status" to values("M", "A", "D", "R", "C", "U", "?"), "oldPath" to optional(string), "adds" to optional(count), "dels" to optional(count))), "truncated" to boolean)),
        method("diffs.file", obj("sessionId" to nonempty, "path" to nonempty, "fromHunk" to optional(count)), obj("path" to string, "binary" to boolean, "hunks" to array(obj("header" to string, "lines" to array(string))), "nextHunk" to optional(number(integer = true)))),
        method("notify.prefs.get", empty, prefs),
        method("notify.prefs.set", prefs, prefs, true),
    ).associateBy { it.metadata.name }

    val methods: List<RcpMethodMetadata> get() = definitions.values.map { it.metadata }
    fun metadata(method: String): RcpMethodMetadata? = definitions[method]?.metadata

    private fun parse(rule: Rule, value: JsonElement?, code: String): JsonObject = try {
        rule(value) as? JsonObject ?: invalid()
    } catch (_: IllegalArgumentException) { throw RcpPayloadException(code) }

    /** Validate request parameters without inventing defaults for missing fields. */
    fun params(method: String, value: JsonElement): JsonObject = parse(definitions[method]?.params ?: throw RcpPayloadException("method_not_found"), value, "invalid_params")
    /** Validate and normalize a successful response. */
    fun result(method: String, value: JsonElement): JsonObject = parse(definitions[method]?.result ?: throw RcpPayloadException("method_not_found"), value, "invalid_result")
    /** Validate and normalize one stream item. */
    fun item(method: String, value: JsonElement): JsonObject = parse(definitions[method]?.item ?: throw RcpPayloadException("invalid_item"), value, "invalid_item")
    fun error(value: JsonElement): JsonObject = parse(error, value, "invalid_error")
    fun sessionEvent(value: JsonElement): JsonObject = parse(sessionEvent, value, "invalid_event")

    /** Validates the exact JSON envelope before typed decoding loses field presence. */
    fun envelope(value: JsonElement): JsonObject {
        val raw = value as? JsonObject ?: throw RcpPayloadException("invalid_request")
        val kind = (raw["k"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val rule = when (kind) {
            "req" -> obj("k" to values("req"), "id" to u32, "m" to nonempty, "p" to optional(empty))
            "res" -> if ((raw["ok"] as? JsonPrimitive)?.booleanOrNull == true) {
                if (raw.containsKey("e")) throw RcpPayloadException("invalid_request")
                obj("k" to values("res"), "id" to u32, "ok" to literal(true), "r" to optional(empty))
            } else {
                if (raw.containsKey("r")) throw RcpPayloadException("invalid_request")
                obj("k" to values("res"), "id" to u32, "ok" to literal(false), "e" to error)
            }
            "item" -> obj("k" to values("item"), "sid" to u32, "n" to count, "d" to empty)
            "end" -> obj("k" to values("end"), "sid" to u32, "ok" to boolean, "e" to optional(error))
            "cancel" -> obj("k" to values("cancel"), "sid" to u32)
            "evt" -> obj("k" to values("evt"), "e" to nonempty, "d" to empty)
            else -> throw RcpPayloadException("invalid_request")
        }
        return parse(rule, raw, "invalid_request")
    }
}
