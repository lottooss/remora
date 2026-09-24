package io.github.lottooss.remora.feature.files

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * File tree, viewer and diffs for one session. Placeholder shell from P1-K2;
 * the real browser arrives with task P4-K2.
 */
@Composable
fun FilesScreen(
    sessionId: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Files",
        task = "P4-K2",
        modifier = modifier,
        onBack = onBack,
    ) {
        Text(
            "Session: $sessionId",
            style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.padding(vertical = 4.dp),
        )
    }
}
