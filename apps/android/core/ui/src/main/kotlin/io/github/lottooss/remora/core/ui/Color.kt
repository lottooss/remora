package io.github.lottooss.remora.core.ui

import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

/**
 * Brand and semantic colors for Remora. The brand teal keeps the app recognizable
 * when dynamic color is unavailable (API < 31 or disabled by the user).
 */
private val RemoraTeal40 = Color(0xFF00696E)
private val RemoraTeal80 = Color(0xFF4DDADF)
private val RemoraTeal20 = Color(0xFF9CF1F5)
private val RemoraTeal90 = Color(0xFFCCEEF1)

private val RemoraGreen40 = Color(0xFF1E7A34)
private val RemoraGreen80 = Color(0xFF7CDB8B)
private val RemoraRed40 = Color(0xFFB3261E)
private val RemoraRed80 = Color(0xFFF2B8B5)

val RemoraLightColors = lightColorScheme(
    primary = RemoraTeal40,
    onPrimary = Color.White,
    primaryContainer = RemoraTeal90,
    onPrimaryContainer = Color(0xFF002022),
    secondary = RemoraGreen40,
    secondaryContainer = Color(0xFFA7F2B3),
    error = RemoraRed40,
    errorContainer = Color(0xFFF9DEDC),
)

val RemoraDarkColors = darkColorScheme(
    primary = RemoraTeal80,
    onPrimary = Color(0xFF003739),
    primaryContainer = RemoraTeal20,
    onPrimaryContainer = Color(0xFF002022),
    secondary = RemoraGreen80,
    secondaryContainer = Color(0xFF005321),
    error = RemoraRed80,
    errorContainer = Color(0xFF8C1D18),
)
