package io.github.lottooss.remora.feature.workspace

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.FsBrowseResult
import io.github.lottooss.remora.core.data.FsEntry
import io.github.lottooss.remora.core.data.ModelRef
import io.github.lottooss.remora.core.data.Workspace
import org.junit.Test

class WorkspaceTest {

    @Test
    fun testWorkspaceRemoteAllowedFiltering() {
        val w1 = Workspace(id = "ws_1", title = "Remora App", path = "C:\\Projects\\remora", remoteAllowed = true)
        val w2 = Workspace(id = "ws_2", title = "Internal OS", path = "C:\\Windows\\System32", remoteAllowed = false)

        val list = listOf(w1, w2)
        val allowed = list.filter { it.remoteAllowed }
        assertThat(allowed).containsExactly(w1)
    }

    @Test
    fun testFsEntryDirectoryFiltering() {
        val entries = listOf(
            FsEntry(name = "src", kind = "dir"),
            FsEntry(name = "build.gradle.kts", kind = "file"),
            FsEntry(name = "docs", kind = "dir"),
            FsEntry(name = "symlink", kind = "link"),
        )
        val dirs = entries.filter { it.isDirectory }
        assertThat(dirs.map { it.name }).containsExactly("src", "docs")
    }

    @Test
    fun testDefaultModelsList() {
        // Since P7-A8 the model list is host-supplied (`availableModels`); the
        // app never fabricates a model the host did not offer.
        assertThat(resolveSelectedModel(current = null, availableModels = emptyList())).isNull()

        val deepseek = ModelRef("deepseek", "deepseek-v4-pro")
        val models = listOf(ModelRef("anthropic", "claude-3-7-sonnet"), deepseek)
        // The first host-supplied model is selected initially, and a host-offered
        // selection is kept…
        assertThat(resolveSelectedModel(current = null, availableModels = models)).isEqualTo(models.first())
        assertThat(resolveSelectedModel(current = deepseek, availableModels = models)).isEqualTo(deepseek)
        // …while a selection the host no longer offers is dropped.
        assertThat(resolveSelectedModel(current = ModelRef("openai", "gpt-4o"), availableModels = models))
            .isEqualTo(models.first())
    }

    @Test
    fun testFsBrowseResultTruncatedFlag() {
        val result = FsBrowseResult(
            path = "/home/user",
            parent = "/home",
            entries = listOf(FsEntry("projects", "dir")),
            truncated = true,
        )
        assertThat(result.truncated).isTrue()
        assertThat(result.parent).isEqualTo("/home")
    }
}
