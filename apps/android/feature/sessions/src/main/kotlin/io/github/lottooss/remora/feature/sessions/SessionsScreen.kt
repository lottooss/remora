package io.github.lottooss.remora.feature.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.ui.ConnectionStatus
import io.github.lottooss.remora.core.ui.PlaceholderScreen
import io.github.lottooss.remora.core.ui.StatusDot

private const val DEMO_SESSION_ID = "demo"

/**
 * Sessions list grouped by workspace. Placeholder shell from P1-K2; the real list,
 * search and live status arrive with task P2-K2.
 */
@Composable
fun SessionsScreen(
    onOpenConversation: (sessionId: String) -> Unit,
    onNewSession: () -> Unit,
    onOpenApprovals: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Sessions",
        task = "P2-K2",
        modifier = modifier,
        onBack = onBack,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(ConnectionStatus.OFFLINE)
            Text("demo host · no sessions yet", style = MaterialTheme.typography.bodyLarge)
        }
        Button(
            onClick = { onOpenConversation(DEMO_SESSION_ID) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Open demo conversation")
        }
        OutlinedButton(onClick = onNewSession, modifier = Modifier.fillMaxWidth()) {
            Text("New session")
        }
        OutlinedButton(onClick = onOpenApprovals, modifier = Modifier.fillMaxWidth()) {
            Text("Approvals inbox")
        }
    }
}
