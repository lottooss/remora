package io.github.lottooss.remora.feature.sessions

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
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import io.github.lottooss.remora.core.data.SessionRepository
import io.github.lottooss.remora.core.data.SessionSummary
import io.github.lottooss.remora.core.ui.ConnectionStatus
import io.github.lottooss.remora.core.ui.StatusDot

/**
 * Sessions list grouped by workspace, with real-time status dots, search filtering,
 * and quick actions for new sessions and approvals inbox.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    onOpenConversation: (sessionId: String) -> Unit,
    onNewSession: () -> Unit,
    onOpenApprovals: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    sessionRepository: SessionRepository? = null,
    initialSessions: List<SessionSummary>? = null,
    connectionStatus: ConnectionStatus = ConnectionStatus.ONLINE,
    onRefresh: (() -> Unit)? = null,
) {
    val repoSessions by sessionRepository?.sessions?.collectAsState()
        ?: remember { mutableStateOf(initialSessions ?: emptyList()) }

    val allSessions = repoSessions.ifEmpty { initialSessions ?: emptyList() }

    var searchQuery by remember { mutableStateOf("") }

    val filteredSessions = remember(allSessions, searchQuery) {
        if (searchQuery.isBlank()) {
            allSessions
        } else {
            val q = searchQuery.trim().lowercase()
            allSessions.filter { s ->
                s.title?.lowercase()?.contains(q) == true ||
                    s.id.lowercase().contains(q) ||
                    s.workspace.title?.lowercase()?.contains(q) == true ||
                    s.workspace.path?.lowercase()?.contains(q) == true
            }
        }
    }

    // Group sessions by workspace title or path
    val groupedSessions = remember(filteredSessions) {
        filteredSessions.groupBy { session ->
            session.workspace.title?.ifBlank { null }
                ?: session.workspace.path?.ifBlank { null }
                ?: "Default Workspace"
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("Sessions", style = MaterialTheme.typography.titleLarge)
                        StatusDot(connectionStatus)
                    }
                },
                actions = {
                    if (onRefresh != null) {
                        OutlinedButton(
                            onClick = onRefresh,
                            modifier = Modifier.padding(end = 8.dp),
                        ) {
                            Text("Refresh")
                        }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surface,
                ),
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp),
        ) {
            // Search field
            OutlinedTextField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 8.dp),
                placeholder = { Text("Search sessions...") },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
            )

            // Action row: New session & Approvals inbox
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = onNewSession,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("+ New Session")
                }
                OutlinedButton(
                    onClick = onOpenApprovals,
                    modifier = Modifier.weight(1f),
                ) {
                    Text("Approvals Inbox")
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            if (groupedSessions.isEmpty()) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .weight(1f),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text(
                            text = if (searchQuery.isNotBlank()) "No sessions matching \"$searchQuery\"" else "No sessions yet",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        if (allSessions.isEmpty()) {
                            Button(onClick = { onOpenConversation("demo") }) {
                                Text("Open Demo Session")
                            }
                        }
                    }
                }
            } else {
                LazyColumn(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    contentPadding = PaddingValues(bottom = 16.dp),
                ) {
                    groupedSessions.forEach { (workspaceName, sessionsInGroup) ->
                        item(key = "header_$workspaceName") {
                            Text(
                                text = "📁 $workspaceName",
                                style = MaterialTheme.typography.titleSmall,
                                fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.primary,
                                modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
                            )
                        }

                        items(sessionsInGroup, key = { it.id }) { session ->
                            SessionCard(
                                session = session,
                                onClick = { onOpenConversation(session.id) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun SessionCard(
    session: SessionSummary,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier.weight(1f),
                ) {
                    SessionStatusIndicator(status = session.status)
                    Text(
                        text = session.title?.ifBlank { "Untitled Session" } ?: "Untitled Session",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Medium,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }

                val model = session.model
                if (model != null) {
                    Surface(
                        shape = RoundedCornerShape(6.dp),
                        color = MaterialTheme.colorScheme.secondaryContainer,
                    ) {
                        Text(
                            text = model.model,
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            color = MaterialTheme.colorScheme.onSecondaryContainer,
                        )
                    }
                }
            }

            Text(
                text = "ID: ${session.id}",
                style = MaterialTheme.typography.bodySmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.outline,
            )
        }
    }
}

@Composable
fun SessionStatusIndicator(status: String, modifier: Modifier = Modifier) {
    val (color, label) = when (status.lowercase()) {
        "running" -> Pair(Color(0xFF2E7D32), "Running")
        "error" -> Pair(Color(0xFFC62828), "Error")
        else -> Pair(Color(0xFF757575), "Idle")
    }

    Box(
        modifier = modifier
            .size(8.dp)
            .clip(RoundedCornerShape(4.dp))
            .background(color)
            .semantics { contentDescription = "Status: $label" },
    )
}
