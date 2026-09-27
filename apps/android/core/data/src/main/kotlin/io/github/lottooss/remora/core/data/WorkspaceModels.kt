package io.github.lottooss.remora.core.data

import kotlinx.serialization.Serializable

@Serializable
data class Workspace(
    val id: String,
    val title: String,
    val path: String,
    val remoteAllowed: Boolean = true,
    val lastUsedAt: Long = 0L,
)

@Serializable
data class FsEntry(
    val name: String,
    val kind: String, // 'dir' | 'file' | 'link'
) {
    val isDirectory: Boolean get() = kind == "dir"
}

@Serializable
data class FsBrowseResult(
    val path: String?,
    val parent: String?,
    val entries: List<FsEntry>,
    val truncated: Boolean = false,
)

@Serializable
data class HostPolicyInfo(
    val allowRemoteSessionStart: Boolean = true,
    val approvalBiometric: String = "never",
    val roots: List<String> = emptyList(),
)
