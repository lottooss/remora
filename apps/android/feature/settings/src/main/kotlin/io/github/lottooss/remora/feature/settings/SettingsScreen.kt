package io.github.lottooss.remora.feature.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.data.NotifyPreferences
import io.github.lottooss.remora.core.data.SettingsUiState
import java.text.DateFormat
import java.util.Date

/** Stateless settings UI. All remote controls require a connected host and loaded values. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    state: SettingsUiState,
    onOpenDiagnostics: () -> Unit,
    onNotificationsChanged: (NotifyPreferences) -> Unit,
    onHostOfflineChanged: (Boolean) -> Unit,
    onRotateApprovalKey: () -> Unit,
    onUnpair: () -> Unit,
    onToggleFlagSecure: ((Boolean) -> Unit)?,
    onToggleAppLock: ((Boolean) -> Unit)?,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    isFlagSecureEnabled: Boolean = true,
    isAppLockEnabled: Boolean = true,
    isPushConfigured: Boolean = true,
    hostOffline: Boolean = true,
    onActivatePendingApprovalKey: (() -> Unit)? = null,
    pendingFingerprint: String? = null,
) {
    var unpairConfirmation by remember { mutableStateOf(false) }
    val enabled = state.connected && !state.loading
    Scaffold(modifier = modifier.fillMaxSize(), topBar = {
        TopAppBar(title = { Text(stringResource(R.string.settings_title)) }, navigationIcon = {
            if (onBack != null) TextButton(onClick = onBack) { Text(stringResource(R.string.settings_back)) }
        })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            if (state.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (!state.connected) item { Text(stringResource(R.string.settings_disconnected)) }
            if (state.errorCode != null) item { Text(stringResource(R.string.settings_failed), color = MaterialTheme.colorScheme.error) }
            item {
                SettingsCard(stringResource(R.string.settings_security)) {
                    SettingToggle(stringResource(R.string.settings_screenshots), isFlagSecureEnabled, onToggleFlagSecure)
                    SettingToggle(stringResource(R.string.settings_app_lock), isAppLockEnabled, onToggleAppLock)
                    if (onToggleFlagSecure == null || onToggleAppLock == null) Text(stringResource(R.string.settings_enforced))
                }
            }
            item {
                SettingsCard(stringResource(R.string.settings_notifications)) {
                    if (!isPushConfigured) Text(stringResource(R.string.settings_push_unavailable))
                    val prefs = state.preferences
                    if (prefs != null) {
                        SettingToggle(stringResource(R.string.settings_approval), prefs.approval,
                            if (enabled) ({ onNotificationsChanged(prefs.copy(approval = it)) }) else null)
                        SettingToggle(stringResource(R.string.settings_question), prefs.question,
                            if (enabled) ({ onNotificationsChanged(prefs.copy(question = it)) }) else null)
                        SettingToggle(stringResource(R.string.settings_turn_done), prefs.turnDone,
                            if (enabled) ({ onNotificationsChanged(prefs.copy(turnDone = it)) }) else null)
                        SettingToggle(stringResource(R.string.settings_turn_error), prefs.turnError,
                            if (enabled) ({ onNotificationsChanged(prefs.copy(turnError = it)) }) else null)
                    }
                    SettingToggle(stringResource(R.string.settings_offline_alert), hostOffline,
                        if (state.device != null && isPushConfigured) onHostOfflineChanged else null)
                }
            }
            item {
                SettingsCard(stringResource(R.string.settings_device)) {
                    state.device?.let { device ->
                        Text(device.name)
                        Text(stringResource(R.string.settings_device_id, device.id.take(6)))
                        Text(stringResource(R.string.settings_paired_at, DateFormat.getDateTimeInstance().format(Date(device.pairedAt))))
                        Text(stringResource(if (device.hardwareBacked == true) R.string.settings_hardware_verified else R.string.settings_hardware_unknown))
                    }
                    if (state.rotationPending) {
                        Text(stringResource(R.string.settings_rotation_pending))
                        if (pendingFingerprint != null) Text(stringResource(R.string.settings_pending_fingerprint, pendingFingerprint))
                        if (onActivatePendingApprovalKey != null) Button(onClick = onActivatePendingApprovalKey,
                            enabled = enabled, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.settings_activate_pending_key))
                        }
                    }
                    Button(onClick = onRotateApprovalKey, enabled = enabled && !state.rotationPending && state.device != null,
                        modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.settings_rotate)) }
                    OutlinedButton(onClick = { unpairConfirmation = true }, enabled = enabled && state.device != null,
                        modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.settings_unpair)) }
                }
            }
            item { OutlinedButton(onClick = onOpenDiagnostics, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.settings_diagnostics)) } }
        }
    }
    if (unpairConfirmation) AlertDialog(onDismissRequest = { unpairConfirmation = false },
        title = { Text(stringResource(R.string.settings_unpair)) }, text = { Text(stringResource(R.string.settings_unpair_confirm)) },
        confirmButton = { TextButton(onClick = { unpairConfirmation = false; onUnpair() }) { Text(stringResource(R.string.settings_unpair)) } },
        dismissButton = { TextButton(onClick = { unpairConfirmation = false }) { Text(stringResource(R.string.settings_cancel)) } })
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    } }
}

@Composable
private fun SettingToggle(label: String, value: Boolean, action: ((Boolean) -> Unit)?) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, Modifier.weight(1f))
        Switch(checked = value, onCheckedChange = action, enabled = action != null)
    }
}
