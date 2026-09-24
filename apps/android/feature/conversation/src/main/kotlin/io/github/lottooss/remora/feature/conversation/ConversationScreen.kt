package io.github.lottooss.remora.feature.conversation

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * Transcript, live stream and composer for one session. Placeholder shell from P1-K2;
 * rendering and controls arrive with task P2-K2.
 */
@Composable
fun ConversationScreen(
    sessionId: String,
    onOpenFiles: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Conversation",
        task = "P2-K2",
        modifier = modifier,
        onBack = onBack,
    ) {
        Text(
            "Session: $sessionId",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(vertical = 4.dp),
        )
        Button(
            onClick = { onOpenFiles(sessionId) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Open session files")
        }
    }
}
