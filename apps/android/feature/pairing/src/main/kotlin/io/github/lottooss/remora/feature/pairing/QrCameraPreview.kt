package io.github.lottooss.remora.feature.pairing

import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Binds only while this screen is composed; each image is closed after ML Kit finishes. */
@androidx.annotation.OptIn(ExperimentalGetImage::class)
@Composable
internal fun QrCameraPreview(
    onPayload: (String) -> Unit,
    onCameraError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val currentPayload = rememberUpdatedState(onPayload)
    val currentError = rememberUpdatedState(onCameraError)
    val previewView = remember(context) { PreviewView(context).apply {
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
        scaleType = PreviewView.ScaleType.FILL_CENTER
    } }
    val description = stringResource(R.string.pair_camera_description)
    AndroidView(factory = { previewView }, modifier = modifier.semantics { contentDescription = description })

    DisposableEffect(previewView, lifecycleOwner) {
        val mainExecutor = ContextCompat.getMainExecutor(context)
        val analysisExecutor = Executors.newSingleThreadExecutor()
        val disposed = AtomicBoolean(false)
        val processing = AtomicBoolean(false)
        val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
        val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        var provider: ProcessCameraProvider? = null
        val future = ProcessCameraProvider.getInstance(context)
        analysis.setAnalyzer(analysisExecutor) { proxy ->
            if (disposed.get() || !processing.compareAndSet(false, true)) {
                proxy.close()
            } else {
                val image = proxy.image
                if (image == null) {
                    processing.set(false)
                    proxy.close()
                } else {
                    try {
                        scanner.process(InputImage.fromMediaImage(image, proxy.imageInfo.rotationDegrees))
                            .addOnSuccessListener(mainExecutor) { barcodes ->
                                if (!disposed.get()) barcodes.firstNotNullOfOrNull { it.rawValue }
                                    ?.takeIf { it.length <= 4096 }
                                    ?.let { currentPayload.value(it) }
                            }
                            .addOnFailureListener(mainExecutor) {
                                if (!disposed.get()) currentError.value()
                            }
                            .addOnCompleteListener {
                                processing.set(false)
                                proxy.close()
                            }
                    } catch (_: Exception) {
                        processing.set(false)
                        proxy.close()
                        mainExecutor.execute { if (!disposed.get()) currentError.value() }
                    }
                }
            }
        }
        future.addListener({
            if (!disposed.get()) {
                try {
                    provider = future.get()
                    provider?.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (_: Exception) {
                    currentError.value()
                }
            }
        }, mainExecutor)
        onDispose {
            disposed.set(true)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis)
            scanner.close()
            analysisExecutor.shutdown()
        }
    }
}
