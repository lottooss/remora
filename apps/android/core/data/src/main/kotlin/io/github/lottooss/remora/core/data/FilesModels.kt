package io.github.lottooss.remora.core.data

import kotlinx.serialization.Serializable

@Serializable
data class FileEntry(
    val name: String,
    val kind: String, // 'dir' | 'file' | 'link'
    val bytes: Long? = null,
    val isBinary: Boolean = false,
)

@Serializable
data class FileListResult(
    val path: String,
    val entries: List<FileEntry>,
    val truncated: Boolean = false,
)

@Serializable
data class FileReadResult(
    val path: String,
    val version: String,
    val offset: Int,
    val text: String,
    val lines: Int,
    val eof: Boolean,
    val bytes: Long? = null,
)

@Serializable
data class DiffFile(
    val path: String,
    val status: String, // 'added' | 'modified' | 'deleted' | 'renamed'
    val oldPath: String? = null,
    val adds: Int = 0,
    val dels: Int = 0,
)

@Serializable
data class DiffStatusResult(
    val source: String,
    val branch: String? = null,
    val files: List<DiffFile>,
    val truncated: Boolean = false,
)

@Serializable
data class DiffHunk(
    val header: String,
    val lines: List<String>,
)

@Serializable
data class DiffFileResult(
    val path: String,
    val binary: Boolean,
    val hunks: List<DiffHunk>,
    val nextHunk: Int? = null,
)
