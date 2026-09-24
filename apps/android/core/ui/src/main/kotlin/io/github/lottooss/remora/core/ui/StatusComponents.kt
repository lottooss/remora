package io.github.lottooss.remora.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Connection status rendered by [StatusDot]; extended by the sync engine in P2-K1. */
enum class ConnectionStatus { ONLINE, OFFLINE, ERROR }

/**
 * Small status dot for host/session list rows (blueprint §10.6 status dots).
 * The semantics description lets TalkBack announce the state without color alone.
 */
@Composable
fun StatusDot(status: ConnectionStatus, modifier: Modifier = Modifier) {
    val color: Color = when (status) {
        ConnectionStatus.ONLINE -> MaterialTheme.colorScheme.primary
        ConnectionStatus.OFFLINE -> MaterialTheme.colorScheme.outlineVariant
        ConnectionStatus.ERROR -> MaterialTheme.colorScheme.error
    }
    val description = when (status) {
        ConnectionStatus.ONLINE -> "Connected"
        ConnectionStatus.OFFLINE -> "Offline"
        ConnectionStatus.ERROR -> "Error"
    }
    Box(
        modifier
            .size(8.dp)
            .background(color, shape = MaterialTheme.shapes.small)
            .semantics { contentDescription = description },
    )
}
