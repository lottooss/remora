package io.github.lottooss.remora.feature.files

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.lottooss.remora.core.data.DiffFile
import io.github.lottooss.remora.core.data.DiffFileResult
import io.github.lottooss.remora.core.data.DiffStatusResult
import io.github.lottooss.remora.core.data.FileEntry
import io.github.lottooss.remora.core.data.FileListResult
import io.github.lottooss.remora.core.data.FileReadResult
import io.github.lottooss.remora.core.data.FilesService
import io.github.lottooss.remora.core.ui.CodeView
import io.github.lottooss.remora.core.ui.DiffHunk
import io.github.lottooss.remora.core.ui.DiffView
import kotlinx.coroutines.launch

/**
 * Full file tree browser, code viewer with line paging and syntax highlighting,
 * and git changes / diff viewer for a session workspace.
 * Zero references to RcpClient or transport in compliance with AGENTS.md §7.5.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FilesScreen(
    sessionId: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    filesService: FilesService? = null,
    initialFiles: List<FileEntry>? = null,
    initialDiffs: DiffStatusResult? = null,
) {
    val service = remember(filesService) { filesService ?: FilesService() }
    val scope = rememberCoroutineScope()

    var selectedTabIndex by remember { mutableIntStateOf(0) } // 0: Files, 1: Changes

    // File Tree state
    var currentDirPath by remember { mutableStateOf("") }
    var fileListResult by remember { mutableStateOf<FileListResult?>(null) }
    var isLoadingFiles by remember { mutableStateOf(false) }
    var filesError by remember { mutableStateOf<String?>(null) }

    // File Viewer state (when viewing a file)
    var activeFilePath by remember { mutableStateOf<String?>(null) }
    var activeFileIsBinary by remember { mutableStateOf(false) }
    var activeFileReadResult by remember { mutableStateOf<FileReadResult?>(null) }
    var isLoadingContent by remember { mutableStateOf(false) }
    var contentError by remember { mutableStateOf<String?>(null) }
    var softWrap by remember { mutableStateOf(false) }

    // Changes / Diff state
    var diffStatusResult by remember { mutableStateOf(initialDiffs) }
    var isLoadingDiffs by remember { mutableStateOf(false) }
    var diffsError by remember { mutableStateOf<String?>(null) }

    // Active Diff viewer state
    var activeDiffPath by remember { mutableStateOf<String?>(null) }
    var activeDiffResult by remember { mutableStateOf<DiffFileResult?>(null) }
    var isLoadingDiffFile by remember { mutableStateOf(false) }
    var diffFileError by remember { mutableStateOf<String?>(null) }

    // Load initial files & diffs
    fun loadFiles(path: String) {
        scope.launch {
            isLoadingFiles = true
            filesError = null
            service.listFiles(sessionId, path).onSuccess { res ->
                fileListResult = res
                currentDirPath = path
            }.onFailure { err ->
                filesError = err.message ?: "Failed to list files"
            }
            isLoadingFiles = false
        }
    }

    fun loadDiffs() {
        scope.launch {
            isLoadingDiffs = true
            diffsError = null
            service.diffStatus(sessionId).onSuccess { res ->
                diffStatusResult = res
            }.onFailure { err ->
                diffsError = err.message ?: "Failed to load git diff status"
            }
            isLoadingDiffs = false
        }
    }

    fun openFile(entry: FileEntry) {
        val fullPath = if (currentDirPath.isEmpty()) entry.name else "$currentDirPath/${entry.name}"
        activeFilePath = fullPath
        activeFileIsBinary = entry.isBinary
        if (entry.isBinary) return

        scope.launch {
            isLoadingContent = true
            contentError = null
            service.readFile(sessionId, fullPath, offset = 1, limit = 200).onSuccess { res ->
                activeFileReadResult = res
            }.onFailure { err ->
                contentError = err.message ?: "Failed to read file"
            }
            isLoadingContent = false
        }
    }

    fun loadMoreLines() {
        val current = activeFileReadResult ?: return
        if (current.eof) return
        val nextOffset = current.offset + current.lines
        val fullPath = activeFilePath ?: return

        scope.launch {
            service.readFile(sessionId, fullPath, offset = nextOffset, limit = 200).onSuccess { nextPart ->
                activeFileReadResult = current.copy(
                    text = current.text + "\n" + nextPart.text,
                    lines = current.lines + nextPart.lines,
                    eof = nextPart.eof,
                    version = nextPart.version,
                )
            }
        }
    }

    fun openDiff(file: DiffFile) {
        activeDiffPath = file.path
        scope.launch {
            isLoadingDiffFile = true
            diffFileError = null
            service.diffFile(sessionId, file.path, fromHunk = 0).onSuccess { res ->
                activeDiffResult = res
            }.onFailure { err ->
                diffFileError = err.message ?: "Failed to load diff for ${file.path}"
            }
            isLoadingDiffFile = false
        }
    }

    fun loadMoreHunks() {
        val current = activeDiffResult ?: return
        val nextHunkIndex = current.nextHunk ?: return
        val path = activeDiffPath ?: return

        scope.launch {
            service.diffFile(sessionId, path, fromHunk = nextHunkIndex).onSuccess { nextPart ->
                activeDiffResult = current.copy(
                    hunks = current.hunks + nextPart.hunks,
                    nextHunk = nextPart.nextHunk,
                )
            }
        }
    }

    LaunchedEffect(sessionId) {
        if (initialFiles != null) {
            fileListResult = FileListResult(path = "", entries = initialFiles)
        } else {
            loadFiles("")
        }
        if (initialDiffs == null) {
            loadDiffs()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        val titleText = when {
                            activeFilePath != null -> activeFilePath!!.substringAfterLast('/')
                            activeDiffPath != null -> activeDiffPath!!.substringAfterLast('/')
                            selectedTabIndex == 0 -> "Files"
                            else -> "Changes"
                        }
                        Text(
                            text = titleText,
                            fontWeight = FontWeight.SemiBold,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        val subtitleText = when {
                            activeFilePath != null -> activeFilePath
                            activeDiffPath != null -> "Diff: $activeDiffPath"
                            else -> "Session: $sessionId"
                        }
                        Text(
                            text = subtitleText.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                },
                navigationIcon = {
                    if (activeFilePath != null || activeDiffPath != null) {
                        TextButton(onClick = {
                            activeFilePath = null
                            activeFileReadResult = null
                            activeDiffPath = null
                            activeDiffResult = null
                        }) {
                            Text("Back")
                        }
                    } else if (onBack != null) {
                        TextButton(onClick = onBack) {
                            Text("Back")
                        }
                    }
                },
                actions = {
                    if (activeFilePath != null && !activeFileIsBinary) {
                        FilterChip(
                            selected = softWrap,
                            onClick = { softWrap = !softWrap },
                            label = { Text("Wrap", fontSize = 11.sp) },
                            modifier = Modifier.padding(end = 8.dp),
                        )
                    }
                    TextButton(onClick = {
                        if (selectedTabIndex == 0) loadFiles(currentDirPath) else loadDiffs()
                    }) {
                        Text("Refresh")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        modifier = modifier,
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            // Only show Tabs when not in active file viewer or diff viewer
            if (activeFilePath == null && activeDiffPath == null) {
                val diffCount = diffStatusResult?.files?.size ?: 0
                TabRow(selectedTabIndex = selectedTabIndex) {
                    Tab(
                        selected = selectedTabIndex == 0,
                        onClick = { selectedTabIndex = 0 },
                        text = { Text("Workspace Files") },
                    )
                    Tab(
                        selected = selectedTabIndex == 1,
                        onClick = {
                            selectedTabIndex = 1
                            if (diffStatusResult == null) loadDiffs()
                        },
                        text = {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text("Changes")
                                if (diffCount > 0) {
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Badge(containerColor = MaterialTheme.colorScheme.primaryContainer) {
                                        Text("$diffCount")
                                    }
                                }
                            }
                        },
                    )
                }
            }

            // Tab 0: Files Browser or File Viewer
            if (selectedTabIndex == 0) {
                if (activeFilePath != null) {
                    // File Content Viewer
                    if (activeFileIsBinary) {
                        Box(
                            modifier = Modifier.fillMaxSize().padding(24.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Card(
                                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                                modifier = Modifier.fillMaxWidth().padding(16.dp),
                            ) {
                                Column(modifier = Modifier.padding(20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Binary File", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                                    Spacer(modifier = Modifier.height(8.dp))
                                    Text(
                                        "Binary files cannot be displayed as text.",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    } else if (isLoadingContent) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else if (contentError != null) {
                        Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("Error loading file", color = MaterialTheme.colorScheme.error)
                                Spacer(Modifier.height(8.dp))
                                Text(contentError.orEmpty(), style = MaterialTheme.typography.bodySmall)
                                Spacer(Modifier.height(12.dp))
                                Button(onClick = { openFile(FileEntry(name = activeFilePath!!.substringAfterLast('/'), kind = "file")) }) {
                                    Text("Retry")
                                }
                            }
                        }
                    } else {
                        val result = activeFileReadResult
                        val isEof = result?.eof ?: true
                        CodeView(
                            text = result?.text.orEmpty(),
                            softWrap = softWrap,
                            onLoadMore = if (!isEof) { { loadMoreLines() } } else null,
                            hasMore = !isEof,
                            modifier = Modifier.fillMaxSize(),
                        )
                    }
                } else {
                    // Directory Tree View
                    Column(Modifier.fillMaxSize()) {
                        // Breadcrumbs bar
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                                .padding(horizontal = 12.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "root",
                                style = MaterialTheme.typography.labelMedium,
                                fontWeight = FontWeight.Bold,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.clickable { loadFiles("") }.padding(4.dp),
                            )
                            if (currentDirPath.isNotEmpty()) {
                                currentDirPath.split("/").filter { it.isNotEmpty() }.forEachIndexed { idx, segment ->
                                    Text(" / ", style = MaterialTheme.typography.labelSmall)
                                    val targetPath = currentDirPath.split("/").take(idx + 1).joinToString("/")
                                    Text(
                                        text = segment,
                                        style = MaterialTheme.typography.labelMedium,
                                        modifier = Modifier.clickable { loadFiles(targetPath) }.padding(4.dp),
                                    )
                                }
                            }
                        }

                        if (isLoadingFiles) {
                            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator()
                            }
                        } else if (filesError != null) {
                            Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Failed to load directory", color = MaterialTheme.colorScheme.error)
                                    Spacer(Modifier.height(8.dp))
                                    Text(filesError.orEmpty(), style = MaterialTheme.typography.bodySmall)
                                    Spacer(Modifier.height(12.dp))
                                    Button(onClick = { loadFiles(currentDirPath) }) {
                                        Text("Retry")
                                    }
                                }
                            }
                        } else {
                            val entries = fileListResult?.entries ?: emptyList()
                            if (entries.isEmpty()) {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text("Directory is empty", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            } else {
                                LazyColumn(
                                    modifier = Modifier.fillMaxSize(),
                                    contentPadding = PaddingValues(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    items(entries, key = { it.name }) { entry ->
                                        FileItemRow(
                                            entry = entry,
                                            onClick = {
                                                if (entry.kind == "dir") {
                                                    val next = if (currentDirPath.isEmpty()) entry.name else "$currentDirPath/${entry.name}"
                                                    loadFiles(next)
                                                } else {
                                                    openFile(entry)
                                                }
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                // Tab 1: Changes / Diff Viewer
                if (activeDiffPath != null) {
                    if (isLoadingDiffFile) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else if (diffFileError != null) {
                        Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("Error loading diff", color = MaterialTheme.colorScheme.error)
                                Spacer(Modifier.height(8.dp))
                                Text(diffFileError.orEmpty(), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    } else {
                        val result = activeDiffResult
                        if (result?.binary == true) {
                            Box(Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                                Text("Binary file diff not supported.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        } else {
                            val uiHunks = result?.hunks?.map { DiffHunk(header = it.header, lines = it.lines) } ?: emptyList()
                            val nextHunk = result?.nextHunk
                            DiffView(
                                hunks = uiHunks,
                                onLoadMoreHunks = if (nextHunk != null) { { loadMoreHunks() } } else null,
                                hasMoreHunks = nextHunk != null,
                                modifier = Modifier.fillMaxSize(),
                            )
                        }
                    }
                } else {
                    // Changes List
                    if (isLoadingDiffs) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else if (diffsError != null) {
                        Box(Modifier.fillMaxSize().padding(16.dp), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("Error loading git diff status", color = MaterialTheme.colorScheme.error)
                                Spacer(Modifier.height(8.dp))
                                Text(diffsError.orEmpty(), style = MaterialTheme.typography.bodySmall)
                                Spacer(Modifier.height(12.dp))
                                Button(onClick = { loadDiffs() }) { Text("Retry") }
                            }
                        }
                    } else {
                        val files = diffStatusResult?.files ?: emptyList()
                        if (files.isEmpty()) {
                            Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                    Text("Working tree clean", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                                    Spacer(Modifier.height(4.dp))
                                    Text("No uncommitted changes in session workspace.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        } else {
                            Column(Modifier.fillMaxSize()) {
                                // Branch & Source header bar
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f))
                                        .padding(horizontal = 16.dp, vertical = 8.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Text(
                                        text = "Branch: ${diffStatusResult?.branch ?: "HEAD"}",
                                        style = MaterialTheme.typography.labelMedium,
                                        fontFamily = FontFamily.Monospace,
                                        fontWeight = FontWeight.Bold,
                                    )
                                    Text(
                                        text = "${files.size} modified files",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }

                                LazyColumn(
                                    modifier = Modifier.fillMaxSize(),
                                    contentPadding = PaddingValues(8.dp),
                                    verticalArrangement = Arrangement.spacedBy(4.dp),
                                ) {
                                    items(files, key = { it.path }) { file ->
                                        DiffFileRow(file = file, onClick = { openDiff(file) })
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileItemRow(entry: FileEntry, onClick: () -> Unit) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { contentDescription = "${entry.name} (${entry.kind})" },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = if (entry.kind == "dir") "📁" else "📄",
                fontSize = 16.sp,
                modifier = Modifier.padding(end = 8.dp),
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = entry.name,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (entry.kind == "dir") FontWeight.SemiBold else FontWeight.Normal,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val bytes = entry.bytes
            if (entry.isBinary) {
                Text(
                    text = "BIN",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.tertiary,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier
                        .background(MaterialTheme.colorScheme.tertiaryContainer, RoundedCornerShape(4.dp))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
            } else if (bytes != null && entry.kind != "dir") {
                Text(
                    text = formatBytes(bytes),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun DiffFileRow(file: DiffFile, onClick: () -> Unit) {
    val (statusLabel, statusColor, statusBg) = when (file.status.uppercase()) {
        "A", "ADDED" -> Triple("A", Color(0xFF2E7D32), Color(0x224CAF50))
        "D", "DELETED" -> Triple("D", Color(0xFFC62828), Color(0x22F44336))
        "R", "RENAMED" -> Triple("R", Color(0xFF6A1B9A), Color(0x229C27B0))
        "?", "UNTRACKED" -> Triple("?", Color(0xFFE65100), Color(0x22FF9800))
        else -> Triple("M", Color(0xFF1565C0), Color(0x222196F3))
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { contentDescription = "${file.path} ($statusLabel)" },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        elevation = CardDefaults.cardElevation(defaultElevation = 1.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(4.dp))
                    .background(statusBg),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = statusLabel,
                    color = statusColor,
                    fontWeight = FontWeight.Bold,
                    fontSize = 12.sp,
                )
            }
            Spacer(modifier = Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = file.path,
                    style = MaterialTheme.typography.bodyMedium,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (file.oldPath != null) {
                    Text(
                        text = "from ${file.oldPath}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (file.adds > 0) {
                    Text(
                        text = "+${file.adds}",
                        color = Color(0xFF2E7D32),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
                if (file.dels > 0) {
                    Text(
                        text = "-${file.dels}",
                        color = Color(0xFFC62828),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

private fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024) return "%.1f KB".format(kb)
    val mb = kb / 1024.0
    return "%.1f MB".format(mb)
}
