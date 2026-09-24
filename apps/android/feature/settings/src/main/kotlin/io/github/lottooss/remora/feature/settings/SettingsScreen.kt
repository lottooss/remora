package io.github.lottooss.remora.feature.settings

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.github.lottooss.remora.core.ui.PlaceholderScreen

/**
 * Settings: devices, notifications, security, diagnostics (blueprint §10.6).
 * Placeholder shell from P1-K2; sections arrive with task P3-K1.
 */
@Composable
fun SettingsScreen(
    onOpenDiagnostics: () -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
) {
    PlaceholderScreen(
        title = "Settings",
        task = "P3-K1",
        modifier = modifier,
        onBack = onBack,
    ) {
        Button(onClick = onOpenDiagnostics, modifier = Modifier.fillMaxWidth()) {
            Text("Diagnostics")
        }
    }
}
