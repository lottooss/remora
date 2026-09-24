package io.github.lottooss.remora.feature.conversation

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * Approvals inbox across hosts (blueprint §10.6). Placeholder shell from P1-K2;
 * previews, risk badges and biometric-gated answers arrive with task P3-K1.
 */
@Composable
fun ApprovalsScreen(
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Approvals",
        task = "P3-K1",
        modifier = modifier,
        onBack = onBack,
    )
}
