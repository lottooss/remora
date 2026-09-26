package io.github.lottooss.remora.feature.conversation

import androidx.compose.animation.AnimatedVisibility
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import io.github.lottooss.remora.core.data.InteractionRepository
import io.github.lottooss.remora.core.data.LiveDeltaOverlay
import io.github.lottooss.remora.core.data.ModelRef
import io.github.lottooss.remora.core.data.PendingApproval
import io.github.lottooss.remora.core.data.PendingInteraction
import io.github.lottooss.remora.core.data.PendingQuestion
import io.github.lottooss.remora.core.data.SessionEvent
import io.github.lottooss.remora.core.data.SessionRepository
import io.github.lottooss.remora.core.data.SyncEngine
import io.github.lottooss.remora.core.ui.ConnectionStatus
import io.github.lottooss.remora.core.ui.StatusDot

/**
 * Conversation screen providing smooth transcript rendering, live streaming bubbles,
 * collapsible tool cards with copyable code, offline policy enforcement,
 * idempotent prompt sending, turn cancellation, and model selection.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConversationScreen(
    sessionId: String,
    onOpenFiles: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    sessionRepository: SessionRepository? = null,
    syncEngine: SyncEngine? = null,
    initialEvents: List<SessionEvent>? = null,
    connectionStatus: ConnectionStatus = ConnectionStatus.ONLINE,
    availableModels: List<ModelRef> = listOf(
        ModelRef("deepseek", "deepseek-chat"),
        ModelRef("deepseek", "deepseek-reasoner"),
    ),
    selectedModel: ModelRef = ModelRef("deepseek", "deepseek-chat"),
    onSelectModel: ((ModelRef) -> Unit)? = null,
    onSendPrompt: ((text: String, delivery: String) -> Unit)? = null,
    onCancelTurn: (() -> Unit)? = null,
    onLoadOlder: (() -> Unit)? = null,
    interactionRepository: InteractionRepository? = null,
    onApprove: ((PendingApproval) -> Unit)? = null,
    onReject: ((PendingApproval) -> Unit)? = null,
    onSubmitQuestion: ((questionId: String, answers: List<String>, text: String?) -> Unit)? = null,
) {
    val repoEvents by sessionRepository?.getEventsFlow(sessionId)?.collectAsState()
        ?: remember { mutableStateOf(initialEvents ?: emptyList()) }

    val liveOverlay by syncEngine?.getLiveOverlay(sessionId)?.collectAsState()
        ?: remember { mutableStateOf(null) }

    val pendingInteractions by interactionRepository?.getPendingForSession(sessionId)?.collectAsState(initial = emptyList())
        ?: remember { mutableStateOf(emptyList()) }
    val pendingApproval = pendingInteractions.filterIsInstance<PendingInteraction.Approval>().firstOrNull()?.approval
    val pendingQuestion = pendingInteractions.filterIsInstance<PendingInteraction.Question>().firstOrNull()?.question

    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(interactionRepository) {
        interactionRepository?.resolvedEvents?.collect { notice ->
            if (notice.by != "phone") {
                snackbarHostState.showSnackbar("Resolved on ${notice.by}")
            }
        }
    }

    val hasOlder = sessionRepository?.hasOlder(sessionId) ?: false

    val events = repoEvents.ifEmpty { initialEvents ?: emptyList() }
    val isRunning = events.any { it is SessionEvent.TurnStart } &&
        events.none { it is SessionEvent.TurnEnd && it.seq > events.filterIsInstance<SessionEvent.TurnStart>().maxOf { s -> s.seq } }

    var inputText by remember { mutableStateOf("") }
    var deliveryMode by remember { mutableStateOf("queue") } // "queue" or "steer"
    var modelMenuExpanded by remember { mutableStateOf(false) }

    val isOnline = connectionStatus == ConnectionStatus.ONLINE
    val listState = rememberLazyListState()

    // Scroll to bottom when new events or live overlay arrives
    LaunchedEffect(events.size, liveOverlay?.text?.length) {
        if (events.isNotEmpty()) {
            listState.animateScrollToItem(events.size - 1)
        }
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(
                                    text = "Session: $sessionId",
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.SemiBold,
                                )
                                StatusDot(connectionStatus)
                            }
                            // Model selector button
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.clickable(enabled = isOnline) {
                                    modelMenuExpanded = true
                                },
                            ) {
                                Text(
                                    text = "Model: ${selectedModel.model} ▼",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                                DropdownMenu(
                                    expanded = modelMenuExpanded,
                                    onDismissRequest = { modelMenuExpanded = false },
                                ) {
                                    availableModels.forEach { m ->
                                        DropdownMenuItem(
                                            text = { Text(m.model) },
                                            onClick = {
                                                onSelectModel?.invoke(m)
                                                modelMenuExpanded = false
                                            },
                                        )
                                    }
                                }
                            }
                        }
                    },
                    actions = {
                        OutlinedButton(onClick = { onOpenFiles(sessionId) }) {
                            Text("Files")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                    ),
                )

                // Offline warning banner
                if (!isOnline) {
                    Surface(
                        color = MaterialTheme.colorScheme.errorContainer,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = "⚠ Disconnected from host — mutating actions are disabled",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }
            }
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
        ) {
            // Transcript List
            LazyColumn(
                state = listState,
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = PaddingValues(vertical = 8.dp),
            ) {
                // "Load older" paging header
                if (hasOlder) {
                    item(key = "load_older_header") {
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 4.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            TextButton(
                                onClick = { onLoadOlder?.invoke() },
                                enabled = isOnline,
                            ) {
                                Text("▲ Load older messages")
                            }
                        }
                    }
                }

                items(events, key = { "evt_${it.seq}_${it.kind}" }) { event ->
                    EventItemView(event = event)
                }

                // Live stream overlay bubble
                if (liveOverlay != null && liveOverlay!!.active && liveOverlay!!.text.isNotBlank()) {
                    item(key = "live_overlay_bubble") {
                        LiveStreamBubble(overlay = liveOverlay!!)
                    }
                }
            }

            // Approval / Question Takeover or Composer bar
            if (pendingApproval != null) {
                ApprovalTakeoverCard(
                    approval = pendingApproval,
                    onApprove = { onApprove?.invoke(it) },
                    onReject = { onReject?.invoke(it) },
                )
            } else if (pendingQuestion != null) {
                QuestionTakeoverCard(
                    question = pendingQuestion,
                    onSubmit = { options, customText ->
                        onSubmitQuestion?.invoke(pendingQuestion.id, options, customText)
                    },
                )
            } else {
                ComposerBar(
                    text = inputText,
                    onTextChange = { inputText = it },
                    delivery = deliveryMode,
                    onDeliveryChange = { deliveryMode = it },
                    isEnabled = isOnline,
                    isRunning = isRunning,
                    onSend = {
                        val prompt = inputText.trim()
                        if (prompt.isNotBlank() && isOnline) {
                            onSendPrompt?.invoke(prompt, deliveryMode)
                            inputText = ""
                        }
                    },
                    onStop = {
                        if (isOnline) {
                            onCancelTurn?.invoke()
                        }
                    },
                )
            }
        }
    }
}

@Composable
fun EventItemView(event: SessionEvent, modifier: Modifier = Modifier) {
    when (event) {
        is SessionEvent.UserMessage -> UserMessageBubble(event, modifier)
        is SessionEvent.AssistantMessage -> AssistantMessageBubble(event, modifier)
        is SessionEvent.ToolCall -> ToolCallCard(event, modifier)
        is SessionEvent.ToolResult -> ToolResultCard(event, modifier)
        is SessionEvent.TurnStart -> TurnMarker(text = "Turn started", modifier)
        is SessionEvent.TurnEnd -> TurnMarker(text = "Turn ended (${event.status})", modifier)
        is SessionEvent.ApprovalDecided -> TurnMarker(text = "Approval: ${event.toolName} -> ${event.outcome}", modifier)
        is SessionEvent.Notice -> TurnMarker(text = "[${event.level.uppercase()}] ${event.text}", modifier)
        is SessionEvent.AssistantAttempt -> TurnMarker(text = "Attempt ${event.outcome}", modifier)
        is SessionEvent.TodoUpdated -> TurnMarker(text = "TODO list updated (${event.items.size} items)", modifier)
        is SessionEvent.Unknown -> TurnMarker(text = "Unknown event (${event.dshType})", modifier)
    }
}

@Composable
fun UserMessageBubble(event: SessionEvent.UserMessage, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End,
    ) {
        Surface(
            shape = RoundedCornerShape(topStart = 16.dp, topEnd = 4.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
            color = MaterialTheme.colorScheme.primaryContainer,
            modifier = Modifier.fillMaxWidth(0.85f),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    text = event.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
        }
    }
}

@Composable
fun AssistantMessageBubble(event: SessionEvent.AssistantMessage, modifier: Modifier = Modifier) {
    var reasoningExpanded by remember { mutableStateOf(false) }

    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start,
    ) {
        Surface(
            shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier.fillMaxWidth(0.92f),
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                // Collapsible reasoning expander
                val reasoning = event.reasoning
                if (!reasoning.isNullOrBlank()) {
                    Surface(
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.6f),
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { reasoningExpanded = !reasoningExpanded },
                    ) {
                        Column(modifier = Modifier.padding(8.dp)) {
                            Text(
                                text = if (reasoningExpanded) "▼ Hide thought process" else "▶ Show thought process",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                            AnimatedVisibility(visible = reasoningExpanded) {
                                Text(
                                    text = reasoning,
                                    style = MaterialTheme.typography.bodySmall,
                                    fontFamily = FontFamily.Monospace,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                    }
                }

                Text(
                    text = event.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
fun LiveStreamBubble(overlay: LiveDeltaOverlay, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start,
    ) {
        Surface(
            shape = RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 16.dp, bottomEnd = 16.dp),
            color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.7f),
            modifier = Modifier.fillMaxWidth(0.92f),
        ) {
            Column(
                modifier = Modifier.padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(MaterialTheme.colorScheme.primary),
                    )
                    Text(
                        text = "Streaming...",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }

                Text(
                    text = overlay.text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
        }
    }
}

@Composable
fun ToolCallCard(event: SessionEvent.ToolCall, modifier: Modifier = Modifier) {
    var expanded by remember { mutableStateOf(false) }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f),
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "🔧 ${event.tool}: ${event.title}",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.SemiBold,
                )
                Text(
                    text = if (expanded) "▲" else "▼",
                    style = MaterialTheme.typography.labelSmall,
                    modifier = Modifier.clickable { expanded = !expanded },
                )
            }

            AnimatedVisibility(visible = expanded) {
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = 4.dp),
                ) {
                    Text(
                        text = event.args.text,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        modifier = Modifier.padding(6.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun ToolResultCard(event: SessionEvent.ToolResult, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    var copied by remember { mutableStateOf(false) }
    var expanded by remember { mutableStateOf(false) }

    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f),
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(10.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = "Tool Result: ${event.status}",
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                    )
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = if (copied) "Copied!" else "Copy",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable {
                            clipboard.setText(AnnotatedString(event.output.text))
                            copied = true
                        },
                    )
                    Text(
                        text = if (expanded) "▲" else "▼",
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.clickable { expanded = !expanded },
                    )
                }
            }

            Surface(
                shape = RoundedCornerShape(6.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = if (expanded || event.output.text.length <= 160) event.output.text else event.output.text.take(160) + "...",
                    style = MaterialTheme.typography.bodySmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.padding(6.dp),
                )
            }
        }
    }
}

@Composable
fun TurnMarker(text: String, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.outline,
        )
    }
}

@Composable
fun ComposerBar(
    text: String,
    onTextChange: (String) -> Unit,
    delivery: String,
    onDeliveryChange: (String) -> Unit,
    isEnabled: Boolean,
    isRunning: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 2.dp,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            // Delivery mode chips (Queue vs Steer)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(
                    selected = delivery == "queue",
                    onClick = { onDeliveryChange("queue") },
                    label = { Text("Queue") },
                    enabled = isEnabled,
                )
                FilterChip(
                    selected = delivery == "steer",
                    onClick = { onDeliveryChange("steer") },
                    label = { Text("Steer (Interrupt)") },
                    enabled = isEnabled,
                )
            }

            // Input field + Send/Stop buttons
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = text,
                    onValueChange = onTextChange,
                    modifier = Modifier.weight(1f),
                    placeholder = { Text(if (isEnabled) "Type prompt..." else "Offline (read only)") },
                    enabled = isEnabled,
                    maxLines = 4,
                    shape = RoundedCornerShape(12.dp),
                )

                if (isRunning) {
                    Button(
                        onClick = onStop,
                        enabled = isEnabled,
                        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                    ) {
                        Text("Stop")
                    }
                }

                Button(
                    onClick = onSend,
                    enabled = isEnabled && text.isNotBlank(),
                ) {
                    Text("Send")
                }
            }
        }
    }
}
