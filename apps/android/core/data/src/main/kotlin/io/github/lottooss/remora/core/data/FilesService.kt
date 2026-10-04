package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Service for listing files within a session workspace, reading file
 * content with pagination, and querying git diff status/hunks.
 * Supports both RcpClient and custom rpcCaller for testing.
 */
class FilesService(
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
        this?.takeIf { it !is JsonNull }
            ?.jsonPrimitive
            ?.takeIf { it.isString }
            ?.content

    private suspend fun requireCall(
        clientOverride: RcpClient?,
        method: String,
        params: JsonElement,
    ): JsonObject {
        val res = call(clientOverride, method, params)
        return res.jsonObject
    }

    suspend fun listFiles(
        sessionId: String,
        path: String = "",
        rcpClient: RcpClient? = null,
    ): Result<FileListResult> {
        return dataResult {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("path", path)
            }
            val res = requireCall(rcpClient, "files.list", params)
            val resPath = res["path"].stringOrNull()
                ?: throw IllegalStateException("Missing path in files.list response")
            val truncated = res["truncated"]?.jsonPrimitive?.booleanOrNull ?: false
            val entriesArr = res["entries"]?.jsonArray ?: emptyList()

            val entries = entriesArr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val name = elem["name"].stringOrNull() ?: return@mapNotNull null
                    val kind = elem["kind"].stringOrNull() ?: "file"
                    val bytes = elem["bytes"]?.jsonPrimitive?.longOrNull
                    val isBinary = elem["binary"]?.jsonPrimitive?.booleanOrNull ?: false
                    FileEntry(name = name, kind = kind, bytes = bytes, isBinary = isBinary)
                } else null
            }

            FileListResult(path = resPath, entries = entries, truncated = truncated)
        }
    }

    suspend fun readFile(
        sessionId: String,
        path: String,
        offset: Int = 1,
        limit: Int = 200,
        rcpClient: RcpClient? = null,
    ): Result<FileReadResult> {
        if (offset < 1) {
            return Result.failure(IllegalArgumentException("offset must be >= 1"))
        }
        if (limit < 1 || limit > 400) {
            return Result.failure(IllegalArgumentException("limit must be between 1 and 400"))
        }

        return dataResult {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("path", path)
                put("offset", offset)
                put("limit", limit)
            }
            val res = requireCall(rcpClient, "files.read", params)
            val resPath = res["path"].stringOrNull()
                ?: throw IllegalStateException("Missing path in files.read response")
            val version = res["version"].stringOrNull()
                ?: throw IllegalStateException("Missing version in files.read response")
            val resOffset = res["offset"]?.jsonPrimitive?.intOrNull
                ?: throw IllegalStateException("Missing offset in files.read response")
            val text = res["text"].stringOrNull()
                ?: throw IllegalStateException("Missing text in files.read response")
            val lines = res["lines"]?.jsonPrimitive?.intOrNull
                ?: throw IllegalStateException("Missing lines in files.read response")
            val eof = res["eof"]?.jsonPrimitive?.booleanOrNull ?: false
            val bytes = res["bytes"]?.jsonPrimitive?.longOrNull

            FileReadResult(
                path = resPath,
                version = version,
                offset = resOffset,
                text = text,
                lines = lines,
                eof = eof,
                bytes = bytes,
            )
        }
    }

    suspend fun diffStatus(
        sessionId: String,
        rcpClient: RcpClient? = null,
    ): Result<DiffStatusResult> {
        return dataResult {
            val params = buildJsonObject {
                put("sessionId", sessionId)
            }
            val res = requireCall(rcpClient, "diffs.status", params)
            val source = res["source"].stringOrNull()
                ?: throw IllegalStateException("Missing source in diffs.status response")
            val branch = res["branch"].stringOrNull()
            val truncated = res["truncated"]?.jsonPrimitive?.booleanOrNull ?: false
            val filesArr = res["files"]?.jsonArray ?: emptyList()

            val files = filesArr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val filePath = elem["path"].stringOrNull() ?: return@mapNotNull null
                    val status = elem["status"].stringOrNull() ?: "modified"
                    val oldPath = elem["oldPath"].stringOrNull()
                    val adds = elem["adds"]?.jsonPrimitive?.intOrNull ?: 0
                    val dels = elem["dels"]?.jsonPrimitive?.intOrNull ?: 0
                    DiffFile(
                        path = filePath,
                        status = status,
                        oldPath = oldPath,
                        adds = adds,
                        dels = dels,
                    )
                } else null
            }

            DiffStatusResult(source = source, branch = branch, files = files, truncated = truncated)
        }
    }

    suspend fun diffFile(
        sessionId: String,
        path: String,
        fromHunk: Int? = null,
        rcpClient: RcpClient? = null,
    ): Result<DiffFileResult> {
        if (fromHunk != null && fromHunk < 0) {
            return Result.failure(IllegalArgumentException("fromHunk must be >= 0"))
        }

        return dataResult {
            val params = buildJsonObject {
                put("sessionId", sessionId)
                put("path", path)
                if (fromHunk != null) {
                    put("fromHunk", fromHunk)
                }
            }
            val res = requireCall(rcpClient, "diffs.file", params)
            val resPath = res["path"].stringOrNull()
                ?: throw IllegalStateException("Missing path in diffs.file response")
            val binary = res["binary"]?.jsonPrimitive?.booleanOrNull ?: false
            val hunksArr = res["hunks"]?.jsonArray ?: emptyList()

            val hunks = hunksArr.mapNotNull { elem ->
                if (elem is JsonObject) {
                    val header = elem["header"].stringOrNull() ?: return@mapNotNull null
                    val linesArr = elem["lines"]?.jsonArray ?: emptyList()
                    val lines = linesArr.mapNotNull { line -> line.stringOrNull() }
                    DiffHunk(header = header, lines = lines)
                } else null
            }

            val nextHunk = res["nextHunk"]?.jsonPrimitive?.intOrNull

            DiffFileResult(
                path = resPath,
                binary = binary,
                hunks = hunks,
                nextHunk = nextHunk,
            )
        }
    }
}
