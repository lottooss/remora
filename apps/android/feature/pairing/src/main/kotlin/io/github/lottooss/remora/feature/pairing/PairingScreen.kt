package io.github.lottooss.remora.feature.pairing

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * Pair a PC via QR + SAS. Placeholder shell from P1-K2; camera scan, enrollment and
 * SAS confirmation arrive with task P2-K1.
 */
@Composable
fun PairingScreen(
    onPaired: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Pair a PC",
        task = "P2-K1",
        modifier = modifier,
        onBack = onBack,
    ) {
        Button(
            onClick = onPaired,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("Continue (placeholder pairing)")
        }
    }
}
