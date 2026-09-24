package io.github.lottooss.remora

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dagger.hilt.android.AndroidEntryPoint
import io.github.lottooss.remora.core.ui.RemoraTheme
import io.github.lottooss.remora.feature.conversation.ConversationScreen
import io.github.lottooss.remora.feature.files.FilesScreen
import io.github.lottooss.remora.feature.pairing.PairingScreen
import io.github.lottooss.remora.feature.sessions.SessionsScreen
import io.github.lottooss.remora.feature.settings.SettingsScreen
import io.github.lottooss.remora.feature.workspace.WorkspaceScreen

/** Skeleton entry point; task P1-K2 replaces the list with the navigation graph. */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RemoraTheme {
                Scaffold(modifier = Modifier.fillMaxSize()) { padding ->
                    Column(
                        Modifier
                            .padding(padding)
                            .padding(16.dp)
                            .verticalScroll(rememberScrollState()),
                    ) {
                        Text("Remora", style = MaterialTheme.typography.headlineMedium)
                        Text("P0 skeleton — remote control for the DeepSeek Harness")
                        PairingScreen()
                        SessionsScreen()
                        ConversationScreen()
                        WorkspaceScreen()
                        FilesScreen()
                        SettingsScreen()
                    }
                }
            }
        }
    }
}
