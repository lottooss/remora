package io.github.lottooss.remora

import android.os.Bundle
import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import androidx.fragment.app.FragmentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.rememberNavController
import dagger.hilt.android.AndroidEntryPoint
import io.github.lottooss.remora.core.security.AppLockGate
import io.github.lottooss.remora.core.security.LockState
import io.github.lottooss.remora.core.security.AndroidBiometricAuthenticator
import io.github.lottooss.remora.core.security.ApprovalKeyManager
import io.github.lottooss.remora.core.ui.RemoraTheme
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import com.google.firebase.messaging.FirebaseMessaging
import javax.inject.Inject

/** Composition root: theme, app-lock gate and the navigation graph (task P1-K2). */
@AndroidEntryPoint
class MainActivity : FragmentActivity() {
    @Inject
    lateinit var appLockGate: AppLockGate
    private lateinit var authenticator: AndroidBiometricAuthenticator
    private var authenticationJob: Job? = null
    private var authenticating by mutableStateOf(false)
    private var authenticationFailed by mutableStateOf(false)
    private val model: RemoraViewModel by viewModels()
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        if (it) refreshPushToken()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        authenticator = AndroidBiometricAuthenticator(this, ApprovalKeyManager(this))
        enableEdgeToEdge()
        setContent {
            RemoraTheme {
                val lockState by appLockGate.state.collectAsStateWithLifecycle()
                LaunchedEffect(lockState) {
                    if (lockState == LockState.UNLOCKED && BuildConfig.HAS_GOOGLE_SERVICES) {
                        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                                this@MainActivity, Manifest.permission.POST_NOTIFICATIONS,
                            ) != PackageManager.PERMISSION_GRANTED
                        ) notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                        else refreshPushToken()
                    }
                }
                when (lockState) {
                    LockState.LOCKED -> AppLockScreen(
                        onAuthenticate = ::requestUnlock,
                        authenticating = authenticating,
                        authenticationFailed = authenticationFailed,
                    )
                    LockState.UNLOCKED -> RemoraRoot(
                        navController = rememberNavController(),
                        model = model,
                        approvalSigner = authenticator::sign,
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        appLockGate.onAppForegrounded()
        model.setForeground(true)
    }

    override fun onStop() {
        authenticationJob?.cancel()
        appLockGate.onAppBackgrounded()
        model.setForeground(false)
        super.onStop()
    }

    private fun refreshPushToken() {
        if (!BuildConfig.HAS_GOOGLE_SERVICES) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token -> model.updatePushToken(token) }
    }

    private fun requestUnlock() {
        if (authenticationJob?.isActive == true) return
        authenticationJob = lifecycleScope.launch {
            authenticating = true
            authenticationFailed = false
            try {
                authenticationFailed = !appLockGate.authenticate(authenticator)
            } finally {
                authenticating = false
            }
        }
    }
}
