package io.github.lottooss.remora.core.data

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class WorkspaceServiceTest {

    @Test
    fun testListWorkspacesParsesCorrectly() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, _ ->
            assertThat(method).isEqualTo("workspaces.list")
            buildJsonObject {
                put("workspaces", buildJsonArray {
                    add(buildJsonObject {
                        put("id", "ws_1")
                        put("title", "Frontend App")
                        put("path", "/home/user/frontend")
                        put("remoteAllowed", true)
                    })
                    add(buildJsonObject {
                        put("id", "ws_2")
                        put("title", "Internal Scripts")
                        put("path", "/etc/scripts")
                        put("remoteAllowed", false)
                    })
                })
            }
        }

        val service = WorkspaceService(rpcCaller = fakeCaller)
        val result = service.listWorkspaces()
        assertThat(result.isSuccess).isTrue()

        val list = result.getOrThrow()
        assertThat(list).hasSize(2)
        assertThat(list[0].id).isEqualTo("ws_1")
        assertThat(list[0].remoteAllowed).isTrue()
        assertThat(list[1].id).isEqualTo("ws_2")
        assertThat(list[1].remoteAllowed).isFalse()
    }

    @Test
    fun testBrowseRootsAndDirectories() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            assertThat(method).isEqualTo("fs.browse")
            val path = params.toString()
            if (!path.contains("path")) {
                // Listing roots
                buildJsonObject {
                    put("path", null as String?)
                    put("parent", null as String?)
                    put("entries", buildJsonArray {
                        add(buildJsonObject {
                            put("name", "C:\\Users\\user\\projects")
                            put("kind", "dir")
                        })
                    })
                    put("truncated", false)
                }
            } else {
                // Inside directory
                buildJsonObject {
                    put("path", "C:\\Users\\user\\projects")
                    put("parent", null as String?)
                    put("entries", buildJsonArray {
                        add(buildJsonObject {
                            put("name", "remora")
                            put("kind", "dir")
                        })
                        add(buildJsonObject {
                            put("name", "notes.txt")
                            put("kind", "file")
                        })
                    })
                    put("truncated", false)
                }
            }
        }

        val service = WorkspaceService(rpcCaller = fakeCaller)

        // 1. Browse roots
        val rootsRes = service.browseFs(path = null).getOrThrow()
        assertThat(rootsRes.path).isNull()
        assertThat(rootsRes.entries).hasSize(1)
        assertThat(rootsRes.entries[0].isDirectory).isTrue()

        // 2. Browse subfolder
        val dirRes = service.browseFs(path = "C:\\Users\\user\\projects").getOrThrow()
        assertThat(dirRes.path).isEqualTo("C:\\Users\\user\\projects")
        assertThat(dirRes.entries).hasSize(2)
        assertThat(dirRes.entries[0].isDirectory).isTrue()
        assertThat(dirRes.entries[1].isDirectory).isFalse()
    }

    @Test
    fun testCreateDirectoryValidatesSingleSegment() = runBlocking {
        val service = WorkspaceService()

        // Empty name
        val emptyRes = service.createDirectory(parent = "/tmp", name = "")
        assertThat(emptyRes.isFailure).isTrue()

        // Slashes in name
        val slashRes = service.createDirectory(parent = "/tmp", name = "sub/folder")
        assertThat(slashRes.isFailure).isTrue()

        val backslashRes = service.createDirectory(parent = "/tmp", name = "sub\\folder")
        assertThat(backslashRes.isFailure).isTrue()
    }

    @Test
    fun testCreateDirectoryDispatchesAndParsesPath() = runBlocking {
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, _ ->
            assertThat(method).isEqualTo("fs.mkdir")
            buildJsonObject {
                put("path", "/tmp/projects/new_app")
            }
        }

        val service = WorkspaceService(rpcCaller = fakeCaller)
        val result = service.createDirectory(parent = "/tmp/projects", name = "new_app")
        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow()).isEqualTo("/tmp/projects/new_app")
    }

    @Test
    fun testStartNewSessionWithPromptExecutesCreateThenPrompt() = runBlocking {
        val calls = mutableListOf<String>()
        val fakeCaller: suspend (String, JsonElement) -> JsonElement = { method, params ->
            calls.add(method)
            when (method) {
                "sessions.create" -> {
                    assertThat(params.toString()).contains("workspace")
                    buildJsonObject {
                        put("sessionId", "session_abc123")
                        put("workspaceId", "ws_456")
                    }
                }
                "sessions.prompt" -> {
                    assertThat(params.toString()).contains("session_abc123")
                    assertThat(params.toString()).contains("First prompt")
                    buildJsonObject {
                        put("accepted", true)
                        put("duplicate", false)
                    }
                }
                else -> error("Unexpected method: $method")
            }
        }

        val service = WorkspaceService(rpcCaller = fakeCaller)
        val result = service.startNewSessionWithPrompt(
            workspacePath = "/data/repo",
            model = ModelRef("deepseek", "deepseek-flash"),
            initialPrompt = "First prompt",
        )

        assertThat(result.isSuccess).isTrue()
        assertThat(result.getOrThrow()).isEqualTo("session_abc123")
        assertThat(calls).containsExactly("sessions.create", "sessions.prompt").inOrder()
    }

    @Test
    fun testDisconnectedHostFailsClosed() = runBlocking {
        val service = WorkspaceService(rpcCaller = null)
        val res = service.listWorkspaces(rcpClient = null)
        assertThat(res.isFailure).isTrue()
        assertThat(res.exceptionOrNull()?.message).contains("disconnected")
    }
}
