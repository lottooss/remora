package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

/**
 * Service managing workspace listing, root/filesystem browsing, directory creation,
 * and new remote session creation with initial prompt submission.
 * Supports both RcpClient and custom rpcCaller for testing.
 */
class WorkspaceService(
    private val rcpClient: RcpClient? = null,
    private val rpcCaller: (suspend (method: String, params: JsonElement) -> JsonElement)? = null,
) {

    private suspend fun call(clientOverride: RcpClient?, method: String, params: JsonElement): JsonElement {
        if (rpcCaller != null) {
            return rpcCaller.invoke(method, params)
        }
        val client = clientOverride ?: rcpClient ?: throw IllegalStateException("Host disconnected")
        return client.call(method, params)
    }

    private fun JsonElement?.stringOrNull(): String? =
        this?.takeIf { it !is JsonNull }?.jsonPrimitive?.content?.takeIf { it != "null" }

    suspend fun listWorkspaces(rcpClient: RcpClient? = null): Result<List<Workspace>> {
        return runCatching {
            val res = call(rcpClient, "workspaces.list", buildJsonObject {}).jsonObject
            val arr = res["workspaces"]?.jsonArray ?: emptyList()
            arr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val id = elem["id"].stringOrNull() ?: return@mapNotNull null
                    val title = elem["title"].stringOrNull() ?: id
                    val path = elem["path"].stringOrNull() ?: ""
                    val remoteAllowed = elem["remoteAllowed"]?.jsonPrimitive?.booleanOrNull ?: true
                    Workspace(id = id, title = title, path = path, remoteAllowed = remoteAllowed)
                } else null
            }
        }
    }

    suspend fun browseFs(path: String? = null, rcpClient: RcpClient? = null): Result<FsBrowseResult> {
        return runCatching {
            val params = buildJsonObject {
                if (path != null) {
                    put("path", path)
                }
            }
            val res = call(rcpClient, "fs.browse", params).jsonObject
            val currentPath = res["path"].stringOrNull()
            val parentPath = res["parent"].stringOrNull()
            val truncated = res["truncated"]?.jsonPrimitive?.booleanOrNull ?: false
            val entriesArr = res["entries"]?.jsonArray ?: emptyList()

            val entries = entriesArr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val name = elem["name"].stringOrNull() ?: return@mapNotNull null
                    val kind = elem["kind"].stringOrNull() ?: "file"
                    FsEntry(name = name, kind = kind)
                } else null
            }

            FsBrowseResult(
                path = currentPath,
                parent = parentPath,
                entries = entries,
                truncated = truncated,
            )
        }
    }

    suspend fun createDirectory(
        parent: String,
        name: String,
        rcpClient: RcpClient? = null,
    ): Result<String> {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) {
            return Result.failure(IllegalArgumentException("Directory name cannot be empty"))
        }
        if (trimmed.contains("/") || trimmed.contains("\\")) {
            return Result.failure(IllegalArgumentException("Directory name must be a single segment"))
        }

        val requestId = UUID.randomUUID().toString()
        return runCatching {
            val params = buildJsonObject {
                put("parent", parent)
                put("name", trimmed)
                put("requestId", requestId)
            }
            val res = call(rcpClient, "fs.mkdir", params).jsonObject
            res["path"].stringOrNull()
                ?: throw IllegalStateException("Missing path in mkdir response")
        }
    }

    suspend fun createSession(
        workspaceId: String? = null,
        workspacePath: String? = null,
        model: ModelRef? = null,
        rcpClient: RcpClient? = null,
    ): Result<Pair<String, String>> {
        if (workspaceId == null && workspacePath == null) {
            return Result.failure(
                IllegalArgumentException("Either workspaceId or workspacePath must be provided")
            )
        }

        val requestId = UUID.randomUUID().toString()
        return runCatching {
            val params = buildJsonObject {
                put("requestId", requestId)
                put("workspace", buildJsonObject {
                    if (workspaceId != null) {
                        put("id", workspaceId)
                    } else if (workspacePath != null) {
                        put("path", workspacePath)
                    }
                })
                if (model != null) {
                    put("model", buildJsonObject {
                        put("provider", model.provider)
                        put("model", model.model)
                        if (model.reasoningEffort != null) {
                            put("reasoningEffort", model.reasoningEffort)
                        }
                    })
                }
            }
            val res = call(rcpClient, "sessions.create", params).jsonObject
            val sessionId = res["sessionId"].stringOrNull()
                ?: throw IllegalStateException("Missing sessionId in sessions.create response")
            val wsId = res["workspaceId"].stringOrNull() ?: ""
            Pair(sessionId, wsId)
        }
    }

    suspend fun startNewSessionWithPrompt(
        workspaceId: String? = null,
        workspacePath: String? = null,
        model: ModelRef? = null,
        initialPrompt: String,
        rcpClient: RcpClient? = null,
    ): Result<String> {
        val promptText = initialPrompt.trim()
        if (promptText.isEmpty()) {
            return Result.failure(IllegalArgumentException("Initial prompt cannot be empty"))
        }

        // Step 1: Create the session
        val createResult = createSession(workspaceId, workspacePath, model, rcpClient)
        val (sessionId, _) = createResult.getOrElse { return Result.failure(it) }

        // Step 2: Send the first prompt (idempotent with fresh requestId)
        val promptRequestId = UUID.randomUUID().toString()
        val promptParams = buildJsonObject {
            put("sessionId", sessionId)
            put("requestId", promptRequestId)
            put("text", promptText)
            put("delivery", "queue")
        }

        return runCatching {
            call(rcpClient, "sessions.prompt", promptParams)
            sessionId
        }
    }
}
