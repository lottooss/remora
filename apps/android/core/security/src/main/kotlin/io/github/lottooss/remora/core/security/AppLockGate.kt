package io.github.lottooss.remora.core.security

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Whether the app shell is visible or waiting behind the lock gate. */
enum class LockState { LOCKED, UNLOCKED }

/**
 * Strong biometric is required until a host-confirmed credential policy is available.
 */
enum class UnlockRequirement { BIOMETRIC_STRONG, DEVICE_CREDENTIAL }

/**
 * Locked on cold start; only the system authenticator can admit the app shell.
 */
class AppLockGate(
    private val backgroundLockMs: Long = DEFAULT_BACKGROUND_LOCK_MS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(LockState.LOCKED)
    val state: StateFlow<LockState> = _state.asStateFlow()

    val unlockRequirement: UnlockRequirement = UnlockRequirement.BIOMETRIC_STRONG

    private var backgroundedAtMs: Long? = null
    private val authenticationMutex = Mutex()
    private var generation = 0L

    /** Cancellation, error, or an explicit lock during a prompt keeps the shell locked. */
    suspend fun authenticate(authenticator: BiometricAuthenticator): Boolean = authenticationMutex.withLock {
        val startedAtGeneration = generation
        val authenticated = authenticator.authenticate()
        if (authenticated && generation == startedAtGeneration) {
            backgroundedAtMs = null
            _state.value = LockState.UNLOCKED
            true
        } else {
            false
        }
    }

    fun lock() {
        generation++
        backgroundedAtMs = null
        _state.value = LockState.LOCKED
    }

    /** Records when the app left the foreground while unlocked (no-op while locked). */
    fun onAppBackgrounded() {
        if (_state.value == LockState.UNLOCKED) {
            backgroundedAtMs = now()
        }
    }

    /** Re-locks when the app returns after [backgroundLockMs] away (blueprint §10.4). */
    fun onAppForegrounded() {
        val backgroundedAt = backgroundedAtMs ?: return
        backgroundedAtMs = null
        if (now() - backgroundedAt >= backgroundLockMs) {
            lock()
        }
    }

    companion object {
        /** 5 minutes in background re-locks the app (blueprint §10.4). */
        const val DEFAULT_BACKGROUND_LOCK_MS: Long = 5 * 60 * 1000L
    }
}
