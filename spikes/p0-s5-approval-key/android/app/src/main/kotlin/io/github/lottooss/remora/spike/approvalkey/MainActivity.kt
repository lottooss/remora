package io.github.lottooss.remora.spike.approvalkey

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.SystemClock
import android.widget.Button
import android.widget.TextView
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.io.File
import java.security.Signature
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Single-activity spike: create a biometric-bound Keystore approval key,
 * sign the canonical Crypto/1 §7 message behind `BiometricPrompt` with a
 * `CryptoObject`, export b64u SPKI + DER signatures for `node verify.mjs`.
 */
class MainActivity : FragmentActivity() {

    private lateinit var deviceInfo: TextView
    private lateinit var keyInfo: TextView
    private lateinit var lastSig: TextView
    private lateinit var logView: TextView
    private lateinit var operationButtons: List<Button>

    private val io: ExecutorService = Executors.newSingleThreadExecutor()
    private val mainExecutor: Executor by lazy { ContextCompat.getMainExecutor(this) }

    private var prompt: BiometricPrompt? = null
    private var busy = false

    private val previewText: String by lazy { getString(R.string.preview_text) }
    private val previewJson: String by lazy { getString(R.string.preview_json) }

    private val results = mutableListOf<SignatureRecord>()
    private val observations = mutableListOf<String>()
    private var keygen: CreateOutcome? = null
    private var currentSpki: String? = null

    private var batchRemaining = 0
    private var credentialMode = false
    private var authStartedAt = 0L
    private var pendingMessage: String? = null
    private var pendingApprovalId: String? = null
    private var pendingIssuedAt = 0L

    private val logLines = ArrayDeque<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        deviceInfo = findViewById(R.id.device_info)
        keyInfo = findViewById(R.id.key_info)
        lastSig = findViewById(R.id.last_sig)
        logView = findViewById(R.id.log)
        operationButtons = listOf(
            findViewById(R.id.btn_create_key),
            findViewById(R.id.btn_sign_once),
            findViewById(R.id.btn_sign_batch),
            findViewById(R.id.btn_sign_no_auth),
            findViewById(R.id.btn_credential),
            findViewById(R.id.btn_probe),
            findViewById(R.id.btn_export),
        )

        deviceInfo.text = "model=${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · " +
            "Android ${android.os.Build.VERSION.RELEASE} (API ${android.os.Build.VERSION.SDK_INT})"

        findViewById<Button>(R.id.btn_create_key).setOnClickListener { createKey() }
        findViewById<Button>(R.id.btn_sign_once).setOnClickListener { startSign(batch = false) }
        findViewById<Button>(R.id.btn_sign_batch).setOnClickListener { startSign(batch = true) }
        findViewById<Button>(R.id.btn_sign_no_auth).setOnClickListener { attemptSignWithoutAuth() }
        findViewById<Button>(R.id.btn_credential).setOnClickListener { attemptCredentialPrompt() }
        findViewById<Button>(R.id.btn_probe).setOnClickListener { probeKey() }
        findViewById<Button>(R.id.btn_export).setOnClickListener { exportResults() }

        log("spike ready · key alias=${ApprovalKeys.ALIAS} · exists=${ApprovalKeys.exists()}")
        if (ApprovalKeys.exists()) refreshKeyInfo()
    }

    override fun onDestroy() {
        runCatching { prompt?.cancelAuthentication() }
        io.shutdown()
        super.onDestroy()
    }

    // ---- key lifecycle ----

    private fun createKey() {
        if (!beginOp()) return
        log("creating key (StrongBox first, TEE fallback)…")
        io.execute {
            val outcome = try {
                ApprovalKeys.create(preferStrongBox = true)
            } catch (t: Throwable) {
                runOnUiThread {
                    log("key generation FAILED: ${t.javaClass.simpleName}: ${t.message}")
                    observe("keygen failed: ${t.javaClass.name}: ${t.message}")
                    endOp()
                }
                return@execute
            }
            runOnUiThread {
                keygen = outcome
                currentSpki = outcome.spki.toB64u()
                val sb = if (outcome.strongBoxUsed) "StrongBox" else "TEE"
                val sbNote = outcome.strongBoxError?.let { " · StrongBox path: $it" } ?: ""
                log(
                    "key created in $sb in ${outcome.keygenMs} ms · " +
                        "attestation chain ${outcome.chain.size} cert(s)$sbNote",
                )
                observe(
                    "keygen: backend=$sb ms=${outcome.keygenMs}" +
                        (outcome.strongBoxError?.let { "; strongBoxError=$it" } ?: ""),
                )
                observe(
                    "attestation root: " +
                        (outcome.chain.lastOrNull()?.subject ?: "none"),
                )
                refreshKeyInfo()
                endOp()
            }
        }
    }

    private fun refreshKeyInfo() {
        val spki = ApprovalKeys.spkiB64u()
        currentSpki = spki
        if (spki == null) {
            keyInfo.text = "no key — tap \"Create key\""
            return
        }
        val chain = ApprovalKeys.attestationChain()
        val sb = keygen?.let { if (it.strongBoxUsed) "StrongBox" else "TEE" } ?: "unknown backend"
        keyInfo.text = buildString {
            append("alias=${ApprovalKeys.ALIAS} · backend=$sb\n")
            append("SPKI (b64u):\n$spki\n")
            append("attestation (${chain.size} cert(s)):\n")
            chain.forEachIndexed { i, cert ->
                val tag = if (cert.isRoot) "root" else if (i == 0) "leaf" else "inter"
                append("  [$tag] ${cert.subject}\n      issuer=${cert.issuer} serial=${cert.serial}\n")
            }
        }
    }

    // ---- biometric signing ----

    private fun startSign(batch: Boolean) {
        if (!ApprovalKeys.exists()) {
            log("no key — create one first")
            return
        }
        if (!beginOp()) return
        batchRemaining = if (batch) BATCH_SIZE else 0
        credentialMode = false
        log(if (batch) "batch starting: $BATCH_SIZE signatures, one fingerprint each" else "signing once…")
        promptNextSignature()
    }

    private fun promptNextSignature() {
        val sequence = results.size + 1
        val approvalId = "spike-%06d".format(Locale.ROOT, sequence)
        val issuedAt = System.currentTimeMillis()
        val message = ApprovalMessage(
            hostId = "h_spike",
            deviceId = "d_spike",
            approvalId = approvalId,
            sessionId = "s-0001",
            callId = "call-1",
            toolName = "bash",
            argsDigest = computeArgsDigest(previewText, previewJson),
            outcome = ApprovalOutcome.ALLOWED_ONCE,
            issuedAt = issuedAt,
        ).canonical()

        pendingMessage = message
        pendingApprovalId = approvalId
        pendingIssuedAt = issuedAt

        io.execute {
            val signer = try {
                ApprovalKeys.newSigner()
            } catch (t: Throwable) {
                runOnUiThread {
                    log("initSign failed: ${t.javaClass.simpleName}: ${t.message}")
                    observe("initSign failed: ${t.javaClass.name}: ${t.message}")
                    if (batchRemaining > 0) log("batch aborted")
                    endOp()
                }
                return@execute
            }
            runOnUiThread {
                authStartedAt = SystemClock.elapsedRealtime()
                showBiometricPrompt(signer, credential = false)
            }
        }
    }

    private fun showBiometricPrompt(signer: Signature, credential: Boolean) {
        val promptInfo = if (credential) {
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.credential_title))
                .setAllowedAuthenticators(AUTH_DEVICE_CREDENTIAL)
                .build()
        } else {
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(getString(R.string.biometric_title))
                .setSubtitle(getString(R.string.biometric_subtitle))
                .setDescription(getString(R.string.biometric_description))
                .setNegativeButtonText(getString(R.string.biometric_cancel))
                .setAllowedAuthenticators(AUTH_BIOMETRIC_STRONG)
                .build()
        }
        val biometricPrompt = BiometricPrompt(this, mainExecutor, biometricCallback())
        prompt = biometricPrompt
        try {
            biometricPrompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signer))
        } catch (t: Throwable) {
            val what = if (credential) "credential prompt" else "biometric prompt"
            log("$what rejected: ${t.javaClass.simpleName}: ${t.message}")
            observe("$what rejected: ${t.javaClass.name}: ${t.message}")
            endOp()
        }
    }

    private fun biometricCallback() = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
            val signer = result.cryptoObject?.signature
            if (signer == null) {
                log("authentication succeeded but CryptoObject.signature is null")
                endOp()
                return
            }
            val message = pendingMessage ?: run {
                log("internal error: no pending message")
                endOp()
                return
            }
            val wasCredential = credentialMode
            io.execute {
                try {
                    signer.update(message.toByteArray(Charsets.UTF_8))
                    val signStart = SystemClock.elapsedRealtime()
                    val der = signer.sign()
                    val signOnlyMs = SystemClock.elapsedRealtime() - signStart
                    val promptToSignMs = SystemClock.elapsedRealtime() - authStartedAt
                    runOnUiThread {
                        if (wasCredential) {
                            val line =
                                "credential auth → sign OK (${der.size} B DER, " +
                                    "prompt→sig ${promptToSignMs} ms) — " +
                                    "device credential CAN unlock this key"
                            log(line)
                            observe(line)
                            endOp()
                            return@runOnUiThread
                        }
                        val record = SignatureRecord(
                            approvalId = pendingApprovalId ?: "unknown",
                            message = message,
                            sigB64u = der.toB64u(),
                            issuedAt = pendingIssuedAt,
                            promptToSignMs = promptToSignMs,
                            signOnlyMs = signOnlyMs,
                        )
                        results.add(record)
                        lastSig.text = "last signature ${record.approvalId} (b64u DER, ${der.size} B):\n${record.sigB64u}"
                        log(
                            "signed ${record.approvalId} in ${results.size}" +
                                (if (batchRemaining > 0 || results.size > 1) "/${results.size + batchRemaining}" else "") +
                                " · prompt→sig ${promptToSignMs} ms · sign-only ${signOnlyMs} ms",
                        )
                        if (batchRemaining > 0) {
                            batchRemaining--
                            promptNextSignature()
                        } else {
                            endOp()
                        }
                    }
                } catch (t: Throwable) {
                    runOnUiThread {
                        log("sign failed: ${t.javaClass.simpleName}: ${t.message}")
                        observe("sign failed: ${t.javaClass.name}: ${t.message}")
                        endOp()
                    }
                }
            }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
            val name = biometricErrorName(errorCode)
            log("auth error: $name ($errorCode) · $errString")
            if (credentialMode) {
                observe("credential prompt: $name ($errorCode) — ${errString}")
            } else if (batchRemaining > 0) {
                observe("batch stopped at ${results.size + 1}: $name")
            }
            endOp()
        }

        override fun onAuthenticationFailed() {
            log("biometric not recognized — prompt stays up")
        }
    }

    // ---- acceptance probes ----

    private fun attemptSignWithoutAuth() {
        if (!ApprovalKeys.exists()) {
            log("no key — create one first")
            return
        }
        if (!beginOp()) return
        val message = nextProbeMessage("no-auth")
        io.execute {
            val outcome = try {
                val signer = ApprovalKeys.newSigner()
                signer.update(message.toByteArray(Charsets.UTF_8))
                val der = signer.sign()
                "SIGNED WITHOUT BIOMETRIC (${der.size} B) — GATE BROKEN"
            } catch (t: Throwable) {
                "${t.javaClass.name}: ${t.message} (expected)"
            }
            runOnUiThread {
                log("direct sign (no BiometricPrompt): $outcome")
                observe("no-auth attempt: $outcome")
                endOp()
            }
        }
    }

    private fun attemptCredentialPrompt() {
        if (!ApprovalKeys.exists()) {
            log("no key — create one first")
            return
        }
        if (!beginOp()) return
        credentialMode = true
        val message = nextProbeMessage("credential")
        pendingMessage = message
        pendingApprovalId = "probe-credential"
        pendingIssuedAt = System.currentTimeMillis()
        log("attempting prompt with DEVICE_CREDENTIAL only (no negative button)…")
        io.execute {
            val signer = try {
                ApprovalKeys.newSigner()
            } catch (t: Throwable) {
                runOnUiThread {
                    log("initSign failed before credential prompt: ${t.javaClass.name}")
                    observe("credential attempt: initSign failed ${t.javaClass.name}")
                    credentialMode = false
                    endOp()
                }
                return@execute
            }
            runOnUiThread {
                authStartedAt = SystemClock.elapsedRealtime()
                showBiometricPrompt(signer, credential = true)
            }
        }
    }

    private fun probeKey() {
        if (!ApprovalKeys.exists()) {
            log("no key — create one first")
            return
        }
        if (!beginOp()) return
        io.execute {
            val probe = ApprovalKeys.probe()
            runOnUiThread {
                val line = when (probe) {
                    KeyProbe.NeedsAuth ->
                        "probe: VALID — direct sign refused without fresh biometric (per-use auth works)"
                    KeyProbe.Invalidated ->
                        "probe: INVALIDATED — key rejected (biometric enrollment changed?); recreate the key"
                    KeyProbe.SignableWithoutAuth ->
                        "probe: SIGNABLE WITHOUT AUTH — gate broken, check spec flags"
                    is KeyProbe.Error ->
                        "probe: ERROR ${probe.detail}"
                }
                log(line)
                observe(line)
                endOp()
            }
        }
    }

    private fun nextProbeMessage(tag: String): String = ApprovalMessage(
        hostId = "h_spike",
        deviceId = "d_spike",
        approvalId = "probe-$tag",
        sessionId = "s-0001",
        callId = null,
        toolName = "bash",
        argsDigest = computeArgsDigest(previewText, previewJson),
        outcome = ApprovalOutcome.REJECTED,
        issuedAt = System.currentTimeMillis(),
    ).canonical()

    // ---- export ----

    private fun exportResults() {
        val spki = currentSpki ?: ApprovalKeys.spkiB64u()
        if (spki == null) {
            log("nothing to export — create a key first")
            return
        }
        if (!beginOp()) return
        io.execute {
            try {
                val json = ExportJson.build(
                    spkiB64u = spki,
                    deviceModel = android.os.Build.MODEL,
                    deviceManufacturer = android.os.Build.MANUFACTURER,
                    androidRelease = android.os.Build.VERSION.RELEASE,
                    sdkInt = android.os.Build.VERSION.SDK_INT,
                    keygen = keygen,
                    previewText = previewText,
                    previewJson = previewJson,
                    observations = observations.toList(),
                    results = results.toList(),
                )
                val dir = getExternalFilesDir(null) ?: filesDir
                val file = File(dir, EXPORT_FILE_NAME)
                file.writeText(json.toString(2))
                runOnUiThread {
                    clipboard().setPrimaryClip(ClipData.newPlainText("P0-S5 results", json.toString()))
                    log("exported ${results.size} signature(s) → ${file.absolutePath}")
                    log("pull with: adb pull \"${file.absolutePath}\" .")
                    log("verify with: node verify.mjs --json $EXPORT_FILE_NAME")
                    endOp()
                }
            } catch (t: Throwable) {
                runOnUiThread {
                    log("export failed: ${t.javaClass.simpleName}: ${t.message}")
                    endOp()
                }
            }
        }
    }

    // ---- plumbing ----

    private fun beginOp(): Boolean {
        if (busy) {
            log("busy — wait for the current operation")
            return false
        }
        busy = true
        operationButtons.forEach { it.isEnabled = false }
        return true
    }

    private fun endOp() {
        busy = false
        credentialMode = false
        pendingMessage = null
        operationButtons.forEach { it.isEnabled = true }
    }

    private fun clipboard(): ClipboardManager =
        getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun observe(line: String) {
        observations.add("${timestamp()} $line")
    }

    private fun log(line: String) {
        logLines.addLast("${timestamp()} $line")
        while (logLines.size > MAX_LOG_LINES) logLines.removeFirst()
        logView.text = logLines.joinToString("\n")
    }

    private fun timestamp(): String =
        SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(Date())

    private fun biometricErrorName(code: Int): String = when (code) {
        BiometricPrompt.ERROR_HW_UNAVAILABLE -> "HW_UNAVAILABLE"
        BiometricPrompt.ERROR_UNABLE_TO_PROCESS -> "UNABLE_TO_PROCESS"
        BiometricPrompt.ERROR_TIMEOUT -> "TIMEOUT"
        BiometricPrompt.ERROR_NO_SPACE -> "NO_SPACE"
        BiometricPrompt.ERROR_CANCELED -> "CANCELED"
        BiometricPrompt.ERROR_LOCKOUT -> "LOCKOUT"
        BiometricPrompt.ERROR_VENDOR -> "VENDOR"
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> "LOCKOUT_PERMANENT"
        BiometricPrompt.ERROR_USER_CANCELED -> "USER_CANCELED"
        BiometricPrompt.ERROR_NO_BIOMETRICS -> "NO_BIOMETRICS_OR_USER_NOT_DETECTED"
        BiometricPrompt.ERROR_HW_NOT_PRESENT -> "HW_NOT_PRESENT"
        BiometricPrompt.ERROR_NEGATIVE_BUTTON -> "NEGATIVE_BUTTON"
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL -> "NO_DEVICE_CREDENTIAL"
        else -> "CODE_$code"
    }

    private companion object {
        const val BATCH_SIZE = 20
        const val MAX_LOG_LINES = 400
        const val EXPORT_FILE_NAME = "P0-S5-results.json"

        // androidx.biometric 1.1.0 has no public Authenticators class; these are
        // the authenticator bit values its setAllowedAuthenticators(int) accepts
        // (verified against the 1.1.0 artifact: BIOMETRIC_STRONG=15, DEVICE_CREDENTIAL=32768).
        const val AUTH_BIOMETRIC_STRONG = 15
        const val AUTH_DEVICE_CREDENTIAL = 32768
    }
}
