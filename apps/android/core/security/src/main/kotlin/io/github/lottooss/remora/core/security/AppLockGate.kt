package io.github.lottooss.remora.core.security

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Whether the app shell is visible or waiting behind the lock gate. */
enum class LockState { LOCKED, UNLOCKED }

/**
 * How [AppLockGate] expects the user to prove presence. The actual BiometricPrompt /
 * device-credential prompt is wired in task P3-K1 (blueprint §10.4: BIOMETRIC_STRONG
 * or device credential on cold start and after the background timeout).
 */
enum class UnlockRequirement { BIOMETRIC_STRONG, DEVICE_CREDENTIAL }

/**
 * App-lock state manager: locked on cold start, unlocked by the (placeholder) prompt,
 * and re-locked after [backgroundLockMs] in the background. Owns no Android APIs, so
 * the state machine is unit-testable; P3-K1 attaches BiometricPrompt + CryptoObject.
 */
class AppLockGate(
    private val backgroundLockMs: Long = DEFAULT_BACKGROUND_LOCK_MS,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _state = MutableStateFlow(LockState.LOCKED)
    val state: StateFlow<LockState> = _state.asStateFlow()

    val unlockRequirement: UnlockRequirement = UnlockRequirement.BIOMETRIC_STRONG

    private var backgroundedAtMs: Long? = null

    /** Called after a successful biometric or PIN/credential check. */
    fun unlock() {
        backgroundedAtMs = null
        _state.value = LockState.UNLOCKED
    }

    fun lock() {
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
            _state.value = LockState.LOCKED
        }
    }

    companion object {
        /** 5 minutes in background re-locks the app (blueprint §10.4). */
        const val DEFAULT_BACKGROUND_LOCK_MS: Long = 5 * 60 * 1000L
    }
}
