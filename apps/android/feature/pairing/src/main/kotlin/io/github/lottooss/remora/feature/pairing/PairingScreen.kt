package io.github.lottooss.remora.feature.pairing

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import io.github.lottooss.remora.core.data.PairingError
import io.github.lottooss.remora.core.data.PairingFlowState
import io.github.lottooss.remora.core.data.validatePairingPayload

@Composable
fun PairingScreen(
    state: PairingFlowState,
    onQrSubmit: (String) -> Unit,
    onPaired: () -> Unit,
    onReset: () -> Unit,
    onBack: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        when (state) {
            PairingFlowState.Idle, PairingFlowState.Scanning -> QrInputContent(onQrSubmit)
            is PairingFlowState.Enrolling -> {
                Text(stringResource(R.string.pair_connecting, state.hostName))
                CircularProgressIndicator()
                TextButton(onClick = onReset) { Text(stringResource(R.string.pair_cancel)) }
            }
            is PairingFlowState.ConfirmingSas -> {
                Text(stringResource(R.string.pair_confirm_title), style = MaterialTheme.typography.headlineMedium)
                Text(stringResource(R.string.pair_confirm_description, state.hostName))
                Text(state.sasCode, style = MaterialTheme.typography.displayMedium.copy(fontFamily = FontFamily.Monospace))
                Text(stringResource(R.string.pair_waiting))
                CircularProgressIndicator()
                TextButton(onClick = onReset) { Text(stringResource(R.string.pair_cancel)) }
            }
            is PairingFlowState.Success -> {
                Text(stringResource(R.string.pair_success_title), style = MaterialTheme.typography.headlineMedium)
                Text(stringResource(R.string.pair_success_description, state.hostName))
                Button(onClick = onPaired, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.pair_done))
                }
            }
            is PairingFlowState.Error -> {
                Text(stringResource(R.string.pair_failed), style = MaterialTheme.typography.headlineMedium)
                Text(stringResource(pairingErrorResource(state.code)), color = MaterialTheme.colorScheme.error)
                Button(onClick = onReset, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(stringResource(R.string.pair_retry))
                }
            }
        }
        if (onBack != null) TextButton(onClick = onBack, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(stringResource(R.string.pair_back))
        }
    }
}

@Composable
private fun QrInputContent(onQrSubmit: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var permissionGranted by remember { mutableStateOf(
        ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
    ) }
    var permissionRequested by remember { mutableStateOf(false) }
    var cameraFailed by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<PairingError?>(null) }
    var submitted by remember { mutableStateOf(false) }
    var manualValue by remember { mutableStateOf("") }
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        permissionGranted = it
        permissionRequested = true
    }
    DisposableEffect(lifecycleOwner, context) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                permissionGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                    PackageManager.PERMISSION_GRANTED
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    fun submit(payload: String) {
        if (submitted) return
        error = validatePairingPayload(payload)
        if (error == null) {
            submitted = true
            manualValue = ""
            onQrSubmit(payload)
        }
    }
    Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.headlineMedium)
    Text(stringResource(R.string.pair_scan_description))
    if (permissionGranted && !cameraFailed && !submitted) {
        QrCameraPreview(
            onPayload = ::submit,
            onCameraError = { cameraFailed = true },
            modifier = Modifier.fillMaxWidth().aspectRatio(1f),
        )
    } else if (!permissionGranted) {
        Text(stringResource(R.string.pair_camera_permission))
        Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.pair_allow_camera))
        }
        if (permissionRequested) TextButton(onClick = {
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:" + context.packageName)))
        }) { Text(stringResource(R.string.pair_open_settings)) }
    } else if (cameraFailed) {
        Text(stringResource(R.string.pair_camera_failed), color = MaterialTheme.colorScheme.error)
        Button(onClick = { cameraFailed = false }) { Text(stringResource(R.string.pair_retry)) }
    }
    error?.let { Text(stringResource(pairingErrorResource(it)), color = MaterialTheme.colorScheme.error) }
    if (BuildConfig.DEBUG) {
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = manualValue,
            onValueChange = { manualValue = it.take(4096) },
            label = { Text(stringResource(R.string.pair_manual_label)) },
            modifier = Modifier.fillMaxWidth(), maxLines = 4,
        )
        Button(onClick = { submit(manualValue.trim()) }, enabled = manualValue.isNotBlank() && !submitted,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
            Text(stringResource(R.string.pair_manual_submit))
        }
    }
}

internal fun pairingErrorResource(error: PairingError): Int = when (error) {
    PairingError.INVALID_QR -> R.string.pair_error_invalid
    PairingError.EXPIRED_QR -> R.string.pair_error_expired
    PairingError.INSECURE_RELAY -> R.string.pair_error_insecure
    PairingError.ALREADY_PAIRED -> R.string.pair_error_already_paired
    PairingError.KEY_UNAVAILABLE -> R.string.pair_error_keys
    PairingError.CONNECTION_FAILED -> R.string.pair_error_connection
    PairingError.REJECTED -> R.string.pair_error_rejected
    PairingError.INVALID_RESPONSE -> R.string.pair_error_response
    PairingError.STORAGE_FAILED -> R.string.pair_error_storage
    PairingError.TIMED_OUT -> R.string.pair_error_timeout
}
