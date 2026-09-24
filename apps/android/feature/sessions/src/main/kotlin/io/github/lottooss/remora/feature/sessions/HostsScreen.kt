package io.github.lottooss.remora.feature.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.ui.ConnectionStatus
import io.github.lottooss.remora.core.ui.PlaceholderScreen
import io.github.lottooss.remora.core.ui.StatusDot

/**
 * Paired PCs list. Placeholder shell from P1-K2; host store and connection state
 * arrive with task P2-K1.
 */
@Composable
fun HostsScreen(
    onOpenSessions: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Hosts",
        task = "P2-K1",
        modifier = modifier,
        onBack = onBack,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusDot(ConnectionStatus.OFFLINE)
            Text(
                "No PCs paired yet",
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.padding(vertical = 4.dp),
            )
        }
        Button(onClick = onOpenSessions, modifier = Modifier.fillMaxWidth()) {
            Text("Open sessions (placeholder)")
        }
    }
}
