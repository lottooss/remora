package io.github.lottooss.remora.feature.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * Diagnostics: connection counters, undecryptable-push counts, versions (P1-K2 goal).
 * Placeholder shell from P1-K2; the real report arrives with task P3-K1.
 */
@Composable
fun DiagnosticsScreen(
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Diagnostics",
        task = "P3-K1",
        modifier = modifier,
        onBack = onBack,
    )
}
