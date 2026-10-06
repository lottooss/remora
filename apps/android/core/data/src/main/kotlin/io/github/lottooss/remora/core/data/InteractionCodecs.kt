package io.github.lottooss.remora.core.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/** RCP/1 interaction decoding. Invalid security fields never receive permissive defaults. */
object InteractionCodecs {
    private val uuid = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    /** Preserves every displayed approval byte and every question in one pending request. */
    fun parsePending(obj: JsonObject): PendingInteraction? = try {
        val id = obj.string("id").also { require(uuid.matches(it)) }
        val sessionId = obj.string("sessionId").also { require(it.isNotEmpty()) }
        val sessionTitle = if (obj["sessionTitle"] == JsonNull) null else obj.string("sessionTitle")
        val createdAt = obj.timestamp("createdAt")
        val expiresAt = obj.timestamp("expiresAt")
        require(expiresAt >= createdAt)
        when (obj.string("kind")) {
            "approval" -> {
                val preview = obj["preview"] as? JsonObject ?: invalid()
                PendingInteraction.Approval(
                    PendingApproval(
                        id = id,
                        sessionId = sessionId,
                        sessionTitle = sessionTitle,
                        toolName = obj.string("toolName").also { require(it.isNotEmpty()) },
                        callId = obj.optionalString("callId"),
                        reason = obj.optionalString("reason"),
                        preview = ApprovalPreview(preview.string("text"), preview.string("json")),
                        argsDigest = obj.string("argsDigest").also { require(it.isNotEmpty()) },
                        risk = obj.string("risk").let { if (it in setOf("normal", "high")) it else "unknown" },
                        requiresSignature = obj.boolean("requiresSignature"),
                        createdAt = createdAt,
                        expiresAt = expiresAt,
                    ),
                )
            }
            "question" -> {
                val questions = (obj["questions"] as? JsonArray ?: invalid()).map { value ->
                    val question = value as? JsonObject ?: invalid()
                    val options = if ("options" in question) {
                        (question["options"] as? JsonArray ?: invalid()).map { optionValue ->
                            val option = optionValue as? JsonObject ?: invalid()
                            QuestionOption(option.string("label"), option.optionalString("description"))
                        }
                    } else emptyList()
                    val intent = if ("intent" in question) {
                        val intentObject = question["intent"] as? JsonObject ?: invalid()
                        QuestionIntent(
                            intentObject.string("kind").also { require(it == "plan-review") },
                            intentObject.string("approve"),
                        )
                    } else null
                    QuestionPrompt(
                        id = question.string("id").also { require(it.isNotEmpty()) },
                        question = question.string("question"),
                        detail = question.optionalString("detail"),
                        header = question.optionalString("header"),
                        options = options,
                        multiSelect = if ("multiSelect" in question) question.boolean("multiSelect") else false,
                        intent = intent,
                    )
                }
                require(questions.map { it.id }.distinct().size == questions.size)
                PendingInteraction.Question(
                    PendingQuestion(id, sessionId, questions, createdAt, expiresAt, sessionTitle),
                )
            }
            else -> null
        }
    } catch (_: IllegalArgumentException) {
        null
    }

    private fun JsonObject.string(key: String): String {
        val value = this[key] as? JsonPrimitive ?: invalid()
        require(value.isString)
        return value.content
    }

    private fun JsonObject.optionalString(key: String): String? = if (key in this) string(key) else null

    private fun JsonObject.boolean(key: String): Boolean {
        val value = this[key] as? JsonPrimitive ?: invalid()
        require(!value.isString)
        return value.booleanOrNull ?: invalid()
    }

    private fun JsonObject.timestamp(key: String): Long {
        val value = this[key] as? JsonPrimitive ?: invalid()
        require(!value.isString)
        return (value.longOrNull ?: invalid()).also { require(it in 0L..9_007_199_254_740_991L) }
    }

    private fun invalid(): Nothing = throw IllegalArgumentException("Malformed pending interaction")
}
