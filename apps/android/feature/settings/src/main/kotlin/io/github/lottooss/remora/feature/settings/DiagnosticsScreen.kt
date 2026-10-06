package io.github.lottooss.remora.feature.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/** Displays the bounded redacted report provided by the diagnostics repository. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiagnosticsScreen(report: String, onBack: (() -> Unit)? = null, modifier: Modifier = Modifier) {
    val clipboard = LocalClipboardManager.current
    Scaffold(modifier = modifier.fillMaxSize(), topBar = {
        TopAppBar(title = { Text(stringResource(R.string.settings_diagnostics)) }, navigationIcon = {
            if (onBack != null) TextButton(onClick = onBack) { Text(stringResource(R.string.settings_back)) }
        })
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(stringResource(R.string.diagnostics_privacy))
            Button(onClick = { clipboard.setText(AnnotatedString(report)) }) { Text(stringResource(R.string.diagnostics_copy)) }
            SelectionContainer { Text(report, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall) }
        }
    }
}
