package io.github.lottooss.remora.feature.workspace

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.lottooss.remora.core.ui.PlaceholderScreen

private const val DEMO_SESSION_ID = "demo"

/**
 * New session: workspace picker / root browser. Placeholder shell from P1-K2;
 * the real picker arrives with task P4-K1.
 */
@Composable
fun WorkspaceScreen(
    onSessionCreated: (sessionId: String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "New session",
        task = "P4-K1",
        modifier = modifier,
        onBack = onBack,
    ) {
        Button(
            onClick = { onSessionCreated(DEMO_SESSION_ID) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Start demo session")
        }
    }
}
