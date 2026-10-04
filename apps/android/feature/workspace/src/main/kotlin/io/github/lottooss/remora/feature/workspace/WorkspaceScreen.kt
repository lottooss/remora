package io.github.lottooss.remora.feature.workspace

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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import io.github.lottooss.remora.core.data.FsBrowseResult
import io.github.lottooss.remora.core.data.FsEntry
import io.github.lottooss.remora.core.data.ModelRef
import io.github.lottooss.remora.core.data.Workspace
import io.github.lottooss.remora.core.data.WorkspaceService
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceScreen(
    onSessionCreated: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    workspaceService: WorkspaceService? = null,
    allowRemoteSessionStart: Boolean = true,
    initialWorkspaces: List<Workspace>? = null,
    initialRoots: List<String>? = null,
    availableModels: List<ModelRef> = emptyList(),
) {
    val service = remember(workspaceService) { workspaceService ?: WorkspaceService() }
    val scope = rememberCoroutineScope()

    var selectedTabIndex by remember { mutableIntStateOf(0) } // 0: Registered Workspaces, 1: Browse Host Roots
    var registeredWorkspaces by remember { mutableStateOf(initialWorkspaces ?: emptyList()) }
    var isLoadingWorkspaces by remember { mutableStateOf(false) }

    // Root browser state
    var currentBrowseResult by remember { mutableStateOf<FsBrowseResult?>(null) }
    var currentPath by remember { mutableStateOf<String?>(null) }
    var isLoadingFs by remember { mutableStateOf(false) }
    var fsError by remember { mutableStateOf<String?>(null) }

    // Target selection: either a Workspace or a folder path
    var selectedWorkspace by remember { mutableStateOf<Workspace?>(null) }
    var selectedDirectoryPath by remember { mutableStateOf<String?>(null) }

    // Model and prompt
    var selectedModel by remember { mutableStateOf<ModelRef?>(null) }
    LaunchedEffect(availableModels) {
        if (selectedModel !in availableModels) selectedModel = availableModels.firstOrNull()
    }
    LaunchedEffect(initialWorkspaces) {
        if (initialWorkspaces != null) registeredWorkspaces = initialWorkspaces
    }
    var promptText by remember { mutableStateOf("") }
    var isStartingSession by remember { mutableStateOf(false) }
    var sessionError by remember { mutableStateOf<String?>(null) }

    // Dialog state for new directory
    var showCreateDirDialog by remember { mutableStateOf(false) }
    var newDirName by remember { mutableStateOf("") }
    var createDirError by remember { mutableStateOf<String?>(null) }

    // Load initial workspaces & roots
    LaunchedEffect(service) {
        isLoadingWorkspaces = true
        service.listWorkspaces().onSuccess {
            registeredWorkspaces = it
        }
        isLoadingWorkspaces = false

        isLoadingFs = true
        service.browseFs(null).onSuccess {
            currentBrowseResult = it
            currentPath = it.path
        }.onFailure {
            fsError = it.message
        }
        isLoadingFs = false
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("New Session", fontWeight = FontWeight.SemiBold) },
                navigationIcon = {
                    if (onBack != null) {
                        TextButton(onClick = onBack) {
                            Text("Back")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
        modifier = modifier.fillMaxSize(),
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp),
        ) {
            if (!allowRemoteSessionStart) {
                Surface(
                    color = MaterialTheme.colorScheme.errorContainer,
                    shape = RoundedCornerShape(8.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 8.dp),
                ) {
                    Text(
                        text = "Remote session start is disabled by host policy. Enable allowRemoteSessionStart on the PC host.",
                        color = MaterialTheme.colorScheme.onErrorContainer,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(12.dp),
                    )
                }
            }

            // Tab bar: Workspaces vs Roots
            TabRow(
                selectedTabIndex = selectedTabIndex,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Tab(
                    selected = selectedTabIndex == 0,
                    onClick = { selectedTabIndex = 0 },
                    text = { Text("Workspaces") },
                )
                Tab(
                    selected = selectedTabIndex == 1,
                    onClick = { selectedTabIndex = 1 },
                    text = { Text("Browse Roots") },
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Main Selection Area
            Box(
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                if (selectedTabIndex == 0) {
                    // TAB 0: Registered Workspaces
                    if (isLoadingWorkspaces) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else if (registeredWorkspaces.isEmpty()) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    "No registered workspaces found",
                                    style = MaterialTheme.typography.bodyLarge,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    "Switch to 'Browse Roots' to start a session in any allowed directory.",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    } else {
                        LazyColumn(
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            contentPadding = PaddingValues(vertical = 4.dp),
                        ) {
                            items(registeredWorkspaces) { ws ->
                                val isSelected = selectedWorkspace?.id == ws.id && selectedDirectoryPath == null
                                Card(
                                    onClick = {
                                        selectedWorkspace = ws
                                        selectedDirectoryPath = null
                                    },
                                    colors = CardDefaults.cardColors(
                                        containerColor = if (isSelected) {
                                            MaterialTheme.colorScheme.primaryContainer
                                        } else {
                                            MaterialTheme.colorScheme.surfaceVariant
                                        },
                                    ),
                                    shape = RoundedCornerShape(8.dp),
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .semantics {
                                            contentDescription = "Workspace ${ws.title}"
                                        },
                                ) {
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(12.dp),
                                        horizontalArrangement = Arrangement.SpaceBetween,
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        Column(modifier = Modifier.weight(1f)) {
                                            Text(
                                                text = ws.title,
                                                style = MaterialTheme.typography.titleMedium,
                                                fontWeight = FontWeight.Bold,
                                            )
                                            Text(
                                                text = ws.path,
                                                style = MaterialTheme.typography.bodySmall,
                                                fontFamily = FontFamily.Monospace,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                            )
                                        }
                                        Spacer(modifier = Modifier.width(8.dp))
                                        Surface(
                                            color = if (ws.remoteAllowed) Color(0xFF2E7D32) else Color(0xFFC62828),
                                            shape = RoundedCornerShape(4.dp),
                                        ) {
                                            Text(
                                                text = if (ws.remoteAllowed) "Remote" else "PC Only",
                                                color = Color.White,
                                                style = MaterialTheme.typography.labelSmall,
                                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                            )
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // TAB 1: Browse Host Roots
                    if (isLoadingFs) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                    } else if (fsError != null) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = "Failed to browse directory",
                                    color = MaterialTheme.colorScheme.error,
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                Text(
                                    text = fsError.orEmpty(),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Button(onClick = {
                                    scope.launch {
                                        fsError = null
                                        isLoadingFs = true
                                        service.browseFs(currentPath).onSuccess {
                                            currentBrowseResult = it
                                        }.onFailure {
                                            fsError = it.message
                                        }
                                        isLoadingFs = false
                                    }
                                }) {
                                    Text("Retry")
                                }
                            }
                        }
                    } else {
                        val result = currentBrowseResult
                        val entries = result?.entries ?: emptyList()
                        val folderEntries = entries.filter { it.isDirectory }

                        Column(Modifier.fillMaxSize()) {
                            // Breadcrumbs navigation
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(
                                    text = "Roots",
                                    style = MaterialTheme.typography.labelLarge,
                                    fontWeight = FontWeight.Bold,
                                    color = MaterialTheme.colorScheme.primary,
                                    modifier = Modifier
                                        .clickable {
                                            scope.launch {
                                                isLoadingFs = true
                                                service.browseFs(null).onSuccess {
                                                    currentBrowseResult = it
                                                    currentPath = null
                                                }
                                                isLoadingFs = false
                                            }
                                        }
                                        .padding(4.dp),
                                )
                                if (currentPath != null) {
                                    Text(" > ", style = MaterialTheme.typography.labelMedium)
                                    Text(
                                        text = currentPath.orEmpty(),
                                        style = MaterialTheme.typography.bodySmall,
                                        fontFamily = FontFamily.Monospace,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }

                            // Directory action bar: Select Current Folder & Create Folder
                            if (currentPath != null) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(vertical = 4.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    val isCurrentSelected = selectedDirectoryPath == currentPath
                                    OutlinedButton(
                                        onClick = {
                                            selectedDirectoryPath = currentPath
                                            selectedWorkspace = null
                                        },
                                    ) {
                                        Text(if (isCurrentSelected) "Selected" else "Select This Folder")
                                    }

                                    Button(
                                        onClick = {
                                            newDirName = ""
                                            createDirError = null
                                            showCreateDirDialog = true
                                        },
                                    ) {
                                        Text("+ New Folder")
                                    }
                                }
                            }

                            Spacer(modifier = Modifier.height(4.dp))

                            if (folderEntries.isEmpty() && (result?.path != null || (initialRoots != null && initialRoots.isEmpty()))) {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .weight(1f),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        if (currentPath == null) {
                                            "No allowed roots configured on the PC. Add 'remoteRoots' in your host config."
                                        } else {
                                            "No subdirectories in this folder."
                                        },
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            } else {
                                LazyColumn(
                                    modifier = Modifier.weight(1f),
                                    verticalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    // If we have a parent, offer [.. Up one level]
                                    if (result?.parent != null) {
                                        item {
                                            Surface(
                                                onClick = {
                                                    scope.launch {
                                                        isLoadingFs = true
                                                        service.browseFs(result.parent).onSuccess {
                                                            currentBrowseResult = it
                                                            currentPath = it.path
                                                        }
                                                        isLoadingFs = false
                                                    }
                                                },
                                                color = MaterialTheme.colorScheme.surfaceVariant,
                                                shape = RoundedCornerShape(6.dp),
                                                modifier = Modifier.fillMaxWidth(),
                                            ) {
                                                Text(
                                                    text = "📁 .. (Up one level)",
                                                    modifier = Modifier.padding(12.dp),
                                                    style = MaterialTheme.typography.bodyMedium,
                                                )
                                            }
                                        }
                                    }

                                    items(folderEntries) { entry ->
                                        val entryFullPath = if (currentPath != null) {
                                            if (currentPath!!.endsWith("/") || currentPath!!.endsWith("\\")) {
                                                currentPath + entry.name
                                            } else {
                                                "$currentPath/${entry.name}"
                                            }
                                        } else {
                                            entry.name
                                        }
                                        val isSelected = selectedDirectoryPath == entryFullPath

                                        Surface(
                                            onClick = {
                                                scope.launch {
                                                    isLoadingFs = true
                                                    service.browseFs(entryFullPath).onSuccess {
                                                        currentBrowseResult = it
                                                        currentPath = it.path
                                                    }.onFailure {
                                                        fsError = it.message
                                                    }
                                                    isLoadingFs = false
                                                }
                                            },
                                            color = if (isSelected) {
                                                MaterialTheme.colorScheme.primaryContainer
                                            } else {
                                                MaterialTheme.colorScheme.surfaceVariant
                                            },
                                            shape = RoundedCornerShape(6.dp),
                                            modifier = Modifier.fillMaxWidth(),
                                        ) {
                                            Row(
                                                modifier = Modifier
                                                    .fillMaxWidth()
                                                    .padding(12.dp),
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Text(
                                                    text = "📁 ${entry.name}",
                                                    style = MaterialTheme.typography.bodyMedium,
                                                    fontWeight = FontWeight.Medium,
                                                )
                                                Text(
                                                    text = "Open >",
                                                    style = MaterialTheme.typography.labelSmall,
                                                    color = MaterialTheme.colorScheme.primary,
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Selected Target Summary
            Surface(
                color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
                shape = RoundedCornerShape(8.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Column(modifier = Modifier.padding(8.dp)) {
                    Text(
                        text = "Target:",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        text = selectedWorkspace?.let { "Workspace: ${it.title} (${it.path})" }
                            ?: selectedDirectoryPath?.let { "Folder: $it" }
                            ?: "None selected (choose a workspace or folder above)",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = if (selectedWorkspace != null || selectedDirectoryPath != null) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Model Picker Chips
            Text(
                text = "Model:",
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
            )
            LazyRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
            ) {
                items(availableModels) { m ->
                    FilterChip(
                        selected = selectedModel == m,
                        onClick = { selectedModel = m },
                        label = { Text("${m.provider}/${m.model}") },
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // First Prompt Composer
            OutlinedTextField(
                value = promptText,
                onValueChange = { promptText = it },
                label = { Text("What would you like to work on?") },
                placeholder = { Text("e.g. Add unit tests for the auth flow...") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                maxLines = 4,
            )

            if (sessionError != null) {
                Text(
                    text = sessionError.orEmpty(),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Start Session Button
            val canStart = allowRemoteSessionStart &&
                (selectedWorkspace != null || selectedDirectoryPath != null) &&
                promptText.isNotBlank() &&
                !isStartingSession

            Button(
                onClick = {
                    isStartingSession = true
                    sessionError = null
                    scope.launch {
                        val result = service.startNewSessionWithPrompt(
                            workspaceId = selectedWorkspace?.id,
                            workspacePath = selectedDirectoryPath ?: selectedWorkspace?.path,
                            model = selectedModel,
                            initialPrompt = promptText,
                        )
                        result.onSuccess { sessionId ->
                            isStartingSession = false
                            onSessionCreated(sessionId)
                        }.onFailure { error ->
                            isStartingSession = false
                            sessionError = error.message ?: "Failed to start session"
                        }
                    }
                },
                enabled = canStart,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp),
            ) {
                if (isStartingSession) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text("Start Session")
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }

        // Create Directory Dialog
        if (showCreateDirDialog) {
            AlertDialog(
                onDismissRequest = { showCreateDirDialog = false },
                title = { Text("Create New Folder") },
                text = {
                    Column {
                        Text(
                            text = "In: ${currentPath.orEmpty()}",
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        OutlinedTextField(
                            value = newDirName,
                            onValueChange = {
                                newDirName = it
                                createDirError = null
                            },
                            label = { Text("Folder Name") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (createDirError != null) {
                            Text(
                                text = createDirError.orEmpty(),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.padding(top = 4.dp),
                            )
                        }
                    }
                },
                confirmButton = {
                    Button(
                        onClick = {
                            val trimmed = newDirName.trim()
                            if (trimmed.isEmpty()) {
                                createDirError = "Folder name cannot be empty"
                                return@Button
                            }
                            if (trimmed.contains("/") || trimmed.contains("\\")) {
                                createDirError = "Name must be a single segment (no / or \\)"
                                return@Button
                            }

                            scope.launch {
                                val current = currentPath
                                if (current != null) {
                                    service.createDirectory(current, trimmed).onSuccess { createdPath ->
                                        showCreateDirDialog = false
                                        selectedDirectoryPath = createdPath
                                        selectedWorkspace = null
                                        // Refresh current directory
                                        service.browseFs(current).onSuccess {
                                            currentBrowseResult = it
                                        }
                                    }.onFailure { err ->
                                        createDirError = err.message ?: "Failed to create directory"
                                    }
                                }
                            }
                        },
                    ) {
                        Text("Create")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showCreateDirDialog = false }) {
                        Text("Cancel")
                    }
                },
            )
        }
    }
}
