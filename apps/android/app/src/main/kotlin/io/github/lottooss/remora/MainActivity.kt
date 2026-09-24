package io.github.lottooss.remora

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.rememberNavController
import dagger.hilt.android.AndroidEntryPoint
import io.github.lottooss.remora.core.security.AppLockGate
import io.github.lottooss.remora.core.security.LockState
import io.github.lottooss.remora.core.ui.RemoraTheme
import javax.inject.Inject

/** Composition root: theme, app-lock gate and the navigation graph (task P1-K2). */
@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    @Inject
    lateinit var appLockGate: AppLockGate

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            RemoraTheme {
                val lockState by appLockGate.state.collectAsStateWithLifecycle()
                when (lockState) {
                    LockState.LOCKED -> AppLockScreen(onUnlock = appLockGate::unlock)
                    LockState.UNLOCKED -> RemoraRoot(navController = rememberNavController())
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        appLockGate.onAppForegrounded()
    }

    override fun onStop() {
        appLockGate.onAppBackgrounded()
        super.onStop()
    }
}
