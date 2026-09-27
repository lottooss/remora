package io.github.lottooss.remora.core.data

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Test

class FilesServiceTest {

    @Test
    fun testListFilesParsesCorrectly() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            assertThat(method).isEqualTo("files.list")
            assertThat(params.toString()).contains("session_1")
            assertThat(params.toString()).contains("/src")
            buildJsonObject {
                put("path", "/src")
                put("truncated", false)
                put("entries", buildJsonArray {
                    add(buildJsonObject {
                        put("name", "main.kt")
                        put("kind", "file")
                        put("bytes", 1024L)
                        put("binary", false)
                    })
                    add(buildJsonObject {
                        put("name", "resources")
                        put("kind", "dir")
                    })
                    add(buildJsonObject {
                        put("name", "blob.bin")
                        put("kind", "file")
                        put("bytes", 4096L)
                        put("binary", true)
                    })
                })
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.listFiles(sessionId = "session_1", path = "/src")
        assertThat(result.isSuccess).isTrue()

        val list = result.getOrThrow()
        assertThat(list.path).isEqualTo("/src")
        assertThat(list.truncated).isFalse()
        assertThat(list.entries).hasSize(3)

        assertThat(list.entries[0].name).isEqualTo("main.kt")
        assertThat(list.entries[0].kind).isEqualTo("file")
        assertThat(list.entries[0].bytes).isEqualTo(1024L)
        assertThat(list.entries[0].isBinary).isFalse()

        assertThat(list.entries[1].name).isEqualTo("resources")
        assertThat(list.entries[1].kind).isEqualTo("dir")
        assertThat(list.entries[1].bytes).isNull()
        assertThat(list.entries[1].isBinary).isFalse()

        assertThat(list.entries[2].name).isEqualTo("blob.bin")
        assertThat(list.entries[2].isBinary).isTrue()
    }

    @Test
    fun testListFilesDefaultsAndTruncated() = runBlocking {
        var capturedParams: JsonElement? = null
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { _, params ->
            capturedParams = params
            buildJsonObject {
                put("path", "")
                put("truncated", true)
                put("entries", buildJsonArray { })
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.listFiles(sessionId = "session_1")
        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow().truncated).isTrue()
        assertThat(result.getOrThrow().entries).isEmpty()

        val paramsObj = capturedParams!!.jsonObject
        assertThat(paramsObj["path"]!!.jsonPrimitive.content).isEqualTo("")
    }

    @Test
    fun testReadFileParsesCorrectly() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            assertThat(method).isEqualTo("files.read")
            val paramsObj = params.jsonObject
            assertThat(paramsObj["sessionId"]!!.jsonPrimitive.content).isEqualTo("session_1")
            assertThat(paramsObj["path"]!!.jsonPrimitive.content).isEqualTo("/src/main.kt")
            assertThat(paramsObj["offset"]!!.jsonPrimitive.int).isEqualTo(1)
            assertThat(paramsObj["limit"]!!.jsonPrimitive.int).isEqualTo(200)
            buildJsonObject {
                put("path", "/src/main.kt")
                put("version", "v1")
                put("offset", 1)
                put("text", "fun main() {}\n")
                put("lines", 1)
                put("eof", true)
                put("bytes", 15L)
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.readFile(sessionId = "session_1", path = "/src/main.kt")
        assertThat(result.isSuccess).isTrue()

        val read = result.getOrThrow()
        assertThat(read.path).isEqualTo("/src/main.kt")
        assertThat(read.version).isEqualTo("v1")
        assertThat(read.offset).isEqualTo(1)
        assertThat(read.text).isEqualTo("fun main() {}\n")
        assertThat(read.lines).isEqualTo(1)
        assertThat(read.eof).isTrue()
        assertThat(read.bytes).isEqualTo(15L)
    }

    @Test
    fun testReadFileSendsCustomPagination() = runBlocking {
        var capturedParams: JsonElement? = null
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { _, params ->
            capturedParams = params
            buildJsonObject {
                put("path", "/src/main.kt")
                put("version", "v2")
                put("offset", 201)
                put("text", "line 201\nline 202\n")
                put("lines", 2)
                put("eof", false)
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.readFile(
            sessionId = "session_1",
            path = "/src/main.kt",
            offset = 201,
            limit = 50,
        )
        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow().eof).isFalse()
        assertThat(result.getOrThrow().bytes).isNull()

        val paramsObj = capturedParams!!.jsonObject
        assertThat(paramsObj["offset"]!!.jsonPrimitive.int).isEqualTo(201)
        assertThat(paramsObj["limit"]!!.jsonPrimitive.int).isEqualTo(50)
    }

    @Test
    fun testReadFileRejectsInvalidPagination() = runBlocking {
        val service = FilesService(rpcCaller = { _, _ -> buildJsonObject {} })

        val zeroOffset = service.readFile(sessionId = "s", path = "/f", offset = 0)
        assertThat(zeroOffset.isFailure).isTrue()
        assertThat(zeroOffset.exceptionOrNull()?.message).contains("offset")

        val negOffset = service.readFile(sessionId = "s", path = "/f", offset = -1)
        assertThat(negOffset.isFailure).isTrue()

        val zeroLimit = service.readFile(sessionId = "s", path = "/f", limit = 0)
        assertThat(zeroLimit.isFailure).isTrue()
        assertThat(zeroLimit.exceptionOrNull()?.message).contains("limit")

        val largeLimit = service.readFile(sessionId = "s", path = "/f", limit = 401)
        assertThat(largeLimit.isFailure).isTrue()
        assertThat(largeLimit.exceptionOrNull()?.message).contains("limit")
    }

    @Test
    fun testDiffStatusParsesCorrectly() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            assertThat(method).isEqualTo("diffs.status")
            assertThat(params.toString()).contains("session_1")
            buildJsonObject {
                put("source", "workspace_1")
                put("branch", "main")
                put("truncated", false)
                put("files", buildJsonArray {
                    add(buildJsonObject {
                        put("path", "src/main.kt")
                        put("status", "modified")
                        put("adds", 3)
                        put("dels", 1)
                    })
                    add(buildJsonObject {
                        put("path", "src/old.kt")
                        put("status", "renamed")
                        put("oldPath", "src/new.kt")
                        put("adds", 0)
                        put("dels", 0)
                    })
                    add(buildJsonObject {
                        put("path", "src/newfile.kt")
                        put("status", "added")
                        put("adds", 10)
                        put("dels", 0)
                    })
                })
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.diffStatus(sessionId = "session_1")
        assertThat(result.isSuccess).isTrue()

        val status = result.getOrThrow()
        assertThat(status.source).isEqualTo("workspace_1")
        assertThat(status.branch).isEqualTo("main")
        assertThat(status.truncated).isFalse()
        assertThat(status.files).hasSize(3)

        assertThat(status.files[0].path).isEqualTo("src/main.kt")
        assertThat(status.files[0].status).isEqualTo("modified")
        assertThat(status.files[0].adds).isEqualTo(3)
        assertThat(status.files[0].dels).isEqualTo(1)
        assertThat(status.files[0].oldPath).isNull()

        assertThat(status.files[1].oldPath).isEqualTo("src/new.kt")

        assertThat(status.files[2].status).isEqualTo("added")
    }

    @Test
    fun testDiffStatusHandlesMissingBranch() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { _, _ ->
            buildJsonObject {
                put("source", "workspace_1")
                put("branch", JsonNull)
                put("files", buildJsonArray { })
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.diffStatus(sessionId = "session_1")
        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow().branch).isNull()
        assertThat(result.getOrThrow().files).isEmpty()
    }

    @Test
    fun testDiffFileParsesHunks() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            assertThat(method).isEqualTo("diffs.file")
            val paramsObj = params.jsonObject
            assertThat(paramsObj["sessionId"]!!.jsonPrimitive.content).isEqualTo("session_1")
            assertThat(paramsObj["path"]!!.jsonPrimitive.content).isEqualTo("src/main.kt")
            assertThat(paramsObj["fromHunk"]).isNull()
            buildJsonObject {
                put("path", "src/main.kt")
                put("binary", false)
                put("hunks", buildJsonArray {
                    add(buildJsonObject {
                        put("header", "@@ -1,3 +1,4 @@")
                        put("lines", buildJsonArray {
                            add(JsonPrimitive(" context"))
                            add(JsonPrimitive("-old line"))
                            add(JsonPrimitive("+new line"))
                        })
                    })
                    add(buildJsonObject {
                        put("header", "@@ -10,2 +11,3 @@")
                        put("lines", buildJsonArray {
                            add(JsonPrimitive("+another add"))
                        })
                    })
                })
                put("nextHunk", 1)
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.diffFile(sessionId = "session_1", path = "src/main.kt")
        assertThat(result.isSuccess).isTrue()

        val diff = result.getOrThrow()
        assertThat(diff.path).isEqualTo("src/main.kt")
        assertThat(diff.binary).isFalse()
        assertThat(diff.nextHunk).isEqualTo(1)
        assertThat(diff.hunks).hasSize(2)

        assertThat(diff.hunks[0].header).isEqualTo("@@ -1,3 +1,4 @@")
        assertThat(diff.hunks[0].lines).containsExactly(" context", "-old line", "+new line").inOrder()

        assertThat(diff.hunks[1].header).isEqualTo("@@ -10,2 +11,3 @@")
        assertThat(diff.hunks[1].lines).containsExactly("+another add").inOrder()
    }

    @Test
    fun testDiffFileSendsFromHunkWhenProvided() = runBlocking {
        var capturedParams: JsonElement? = null
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { _, params ->
            capturedParams = params
            buildJsonObject {
                put("path", "src/main.kt")
                put("binary", true)
                put("hunks", buildJsonArray { })
            }
        }

        val service = FilesService(rpcCaller = fakeCaller)
        val result = service.diffFile(
            sessionId = "session_1",
            path = "src/main.kt",
            fromHunk = 5,
        )
        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow().binary).isTrue()
        assertThat(result.getOrThrow().hunks).isEmpty()
        assertThat(result.getOrThrow().nextHunk).isNull()

        val paramsObj = capturedParams!!.jsonObject
        assertThat(paramsObj["fromHunk"]!!.jsonPrimitive.int).isEqualTo(5)
    }

    @Test
    fun testDiffFileNegativeFromHunkFailsClosed() = runBlocking {
        val service = FilesService(rpcCaller = { _, _ -> buildJsonObject {} })
        val res = service.diffFile(sessionId = "s", path = "/f", fromHunk = -1)
        assertThat(res.isFailure).isTrue()
        assertThat(res.exceptionOrNull()?.message).contains("fromHunk")
    }

    @Test
    fun testFailsClosedWhenHostDisconnected() = runBlocking {
        val service = FilesService(rpcCaller = null)

        assertThat(service.listFiles(sessionId = "s").isFailure).isTrue()
        assertThat(service.readFile(sessionId = "s", path = "/f").isFailure).isTrue()
        assertThat(service.diffStatus(sessionId = "s").isFailure).isTrue()
        assertThat(service.diffFile(sessionId = "s", path = "/f").isFailure).isTrue()
    }

    @Test
    fun testRpcFailuresPropagateAsFailures() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { _, _ ->
            throw IllegalStateException("network error")
        }
        val service = FilesService(rpcCaller = fakeCaller)

        val listRes = service.listFiles(sessionId = "s")
        assertThat(listRes.isFailure).isTrue()
        assertThat(listRes.exceptionOrNull()?.message).contains("network error")

        val readRes = service.readFile(sessionId = "s", path = "/f")
        assertThat(readRes.isFailure).isTrue()

        val diffStatusRes = service.diffStatus(sessionId = "s")
        assertThat(diffStatusRes.isFailure).isTrue()

        val diffFileRes = service.diffFile(sessionId = "s", path = "/f")
        assertThat(diffFileRes.isFailure).isTrue()
    }

    @Test
    fun testMissingRequiredFieldsFailClosed() = runBlocking {
        val missingPathCaller: suspend (String, JsonElement) -> JsonElement = { _, _ ->
            buildJsonObject {
                put("entries", buildJsonArray { })
            }
        }
        val service = FilesService(rpcCaller = missingPathCaller)
        val result = service.listFiles(sessionId = "s")
        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()?.message).contains("path")

        val missingVersionCaller: suspend (String, JsonElement) -> JsonElement = { _, _ ->
            buildJsonObject {
                put("path", "/f")
                put("offset", 1)
                put("text", "hello")
                put("lines", 1)
                put("eof", true)
            }
        }
        val service2 = FilesService(rpcCaller = missingVersionCaller)
        val readResult = service2.readFile(sessionId = "s", path = "/f")
        assertThat(readResult.isFailure).isTrue()
        assertThat(readResult.exceptionOrNull()?.message).contains("version")
    }
}
