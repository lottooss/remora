package io.github.lottooss.remora.core.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Placeholder used by feature modules until their task lands. */
@Composable
fun PlaceholderScreen(title: String, task: String, modifier: Modifier = Modifier) {
    Column(modifier.padding(vertical = 8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text("Arrives with task $task", style = MaterialTheme.typography.bodyMedium)
    }
}
