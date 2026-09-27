package io.github.lottooss.remora.feature.files

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.DiffFile
import io.github.lottooss.remora.core.data.DiffStatusResult
import io.github.lottooss.remora.core.data.FileEntry
import io.github.lottooss.remora.core.data.FileListResult
import io.github.lottooss.remora.core.data.FileReadResult
import org.junit.Test

class FilesScreenTest {

    @Test
    fun testFileEntryPropertiesAndBinaryFlag() {
        val textFile = FileEntry(name = "App.kt", kind = "file", bytes = 2048L, isBinary = false)
        assertThat(textFile.name).isEqualTo("App.kt")
        assertThat(textFile.kind).isEqualTo("file")
        assertThat(textFile.bytes).isEqualTo(2048L)
        assertThat(textFile.isBinary).isFalse()

        val binFile = FileEntry(name = "logo.png", kind = "file", bytes = 1048576L, isBinary = true)
        assertThat(binFile.isBinary).isTrue()

        val dirEntry = FileEntry(name = "src", kind = "dir", bytes = null, isBinary = false)
        assertThat(dirEntry.kind).isEqualTo("dir")
    }

    @Test
    fun testFileListResultTreeFiltering() {
        val entries = listOf(
            FileEntry("build.gradle.kts", "file", 500L),
            FileEntry("src", "dir"),
            FileEntry("gradlew", "file", 1000L),
        )
        val result = FileListResult(path = "project", entries = entries, truncated = false)

        val directories = result.entries.filter { it.kind == "dir" }
        val files = result.entries.filter { it.kind == "file" }

        assertThat(directories).hasSize(1)
        assertThat(directories[0].name).isEqualTo("src")
        assertThat(files).hasSize(2)
    }

    @Test
    fun testFileReadPaging() {
        val firstPage = FileReadResult(
            path = "large.txt",
            version = "v1",
            offset = 1,
            text = "line 1\nline 2",
            lines = 2,
            eof = false,
            bytes = 100L,
        )
        assertThat(firstPage.offset).isEqualTo(1)
        assertThat(firstPage.eof).isFalse()

        val secondPage = FileReadResult(
            path = "large.txt",
            version = "v1",
            offset = 3,
            text = "line 3",
            lines = 1,
            eof = true,
            bytes = 150L,
        )
        assertThat(secondPage.offset).isEqualTo(3)
        assertThat(secondPage.eof).isTrue()

        // Verify simulated combined text
        val combinedText = firstPage.text + "\n" + secondPage.text
        assertThat(combinedText.lines()).hasSize(3)
    }

    @Test
    fun testDiffStatusFileCounts() {
        val diffFiles = listOf(
            DiffFile(path = "A.kt", status = "M", adds = 5, dels = 2),
            DiffFile(path = "B.kt", status = "A", adds = 12, dels = 0),
            DiffFile(path = "C.kt", status = "D", adds = 0, dels = 30),
            DiffFile(path = "D.kt", status = "R", oldPath = "OldD.kt", adds = 1, dels = 1),
            DiffFile(path = "E.txt", status = "?", adds = 4, dels = 0),
        )
        val status = DiffStatusResult(
            source = "git",
            branch = "feature/files",
            files = diffFiles,
            truncated = false,
        )

        assertThat(status.files).hasSize(5)
        assertThat(status.branch).isEqualTo("feature/files")

        val modified = status.files.filter { it.status == "M" }
        val added = status.files.filter { it.status == "A" }
        val deleted = status.files.filter { it.status == "D" }
        val renamed = status.files.filter { it.status == "R" }
        val untracked = status.files.filter { it.status == "?" }

        assertThat(modified).hasSize(1)
        assertThat(added).hasSize(1)
        assertThat(deleted).hasSize(1)
        assertThat(renamed).hasSize(1)
        assertThat(untracked).hasSize(1)
    }
}
