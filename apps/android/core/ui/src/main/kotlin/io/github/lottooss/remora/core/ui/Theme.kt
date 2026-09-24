package io.github.lottooss.remora.core.ui

import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/**
 * Material 3 theme: dark mode follows the system, dynamic color (Android 12+) is
 * used when available and falls back to the Remora brand palette otherwise.
 */
@Composable
fun RemoraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> RemoraDarkColors
        else -> RemoraLightColors
    }
    MaterialTheme(
        colorScheme = colorScheme,
        typography = RemoraTypography,
        content = content,
    )
}
