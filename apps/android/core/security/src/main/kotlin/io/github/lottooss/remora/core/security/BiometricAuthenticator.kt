package io.github.lottooss.remora.core.security

import android.security.keystore.KeyPermanentlyInvalidatedException
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** System authentication boundary; callers never receive an unauthenticated signer. */
interface BiometricAuthenticator {
    suspend fun authenticate(): Boolean
    suspend fun sign(hostId: String, message: ByteArray): ByteArray
}

enum class AuthenticationFailure { UNAVAILABLE, CANCELLED, FAILED, KEY_INVALIDATED }

class AuthenticationException(val reason: AuthenticationFailure) :
    IllegalStateException("Authentication could not be completed")

/** One activity owns one prompt; a second operation waits instead of replacing it. */
class AndroidBiometricAuthenticator(
    private val activity: FragmentActivity,
    private val approvalKeys: ApprovalKeyManager,
) : BiometricAuthenticator {
    private val mutex = Mutex()

    override suspend fun authenticate(): Boolean = mutex.withLock {
        withContext(Dispatchers.Main.immediate) {
            try {
                prompt(null, R.string.security_unlock_title)
                true
            } catch (_: AuthenticationException) {
                false
            }
        }
    }

    override suspend fun sign(hostId: String, message: ByteArray): ByteArray = mutex.withLock {
        require(message.isNotEmpty() && message.size <= 49_152) { "Invalid signing message" }
        val bytes = message.copyOf()
        try {
            val cryptoObject = withContext(Dispatchers.IO) {
                try {
                    approvalKeys.createCryptoObject(hostId)
                } catch (_: KeyPermanentlyInvalidatedException) {
                    throw AuthenticationException(AuthenticationFailure.KEY_INVALIDATED)
                } catch (_: Exception) {
                    throw AuthenticationException(AuthenticationFailure.UNAVAILABLE)
                }
            }
            withContext(Dispatchers.Main.immediate) {
                val result = prompt(cryptoObject, R.string.security_approval_title)
                val signature = result.cryptoObject?.signature
                if (signature == null || signature !== cryptoObject.signature) {
                    throw AuthenticationException(AuthenticationFailure.FAILED)
                }
                try {
                    signature.update(bytes)
                    signature.sign()
                } catch (_: Exception) {
                    throw AuthenticationException(AuthenticationFailure.FAILED)
                }
            }
        } finally {
            bytes.fill(0)
        }
    }

    private suspend fun prompt(
        cryptoObject: BiometricPrompt.CryptoObject?,
        title: Int,
    ): BiometricPrompt.AuthenticationResult {
        val authenticators = BiometricManager.Authenticators.BIOMETRIC_STRONG
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) ||
            BiometricManager.from(activity).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS
        ) throw AuthenticationException(AuthenticationFailure.UNAVAILABLE)

        return suspendCancellableCoroutine { continuation ->
            var observer: LifecycleEventObserver? = null
            fun removeObserver() {
                observer?.let { activity.lifecycle.removeObserver(it) }
                observer = null
            }
            val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        removeObserver()
                        if (continuation.isActive) {
                            if (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) continuation.resume(result)
                            else continuation.resumeWithException(AuthenticationException(AuthenticationFailure.CANCELLED))
                        }
                    }

                    override fun onAuthenticationError(code: Int, text: CharSequence) {
                        removeObserver()
                        val reason = when (code) {
                            BiometricPrompt.ERROR_CANCELED, BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON -> AuthenticationFailure.CANCELLED
                            else -> AuthenticationFailure.FAILED
                        }
                        if (continuation.isActive) continuation.resumeWithException(AuthenticationException(reason))
                    }
                })
            observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_STOP) {
                    removeObserver()
                    prompt.cancelAuthentication()
                    if (continuation.isActive) continuation.resumeWithException(
                        AuthenticationException(AuthenticationFailure.CANCELLED),
                    )
                }
            }.also { activity.lifecycle.addObserver(it) }
            continuation.invokeOnCancellation {
                ContextCompat.getMainExecutor(activity).execute {
                    removeObserver()
                    prompt.cancelAuthentication()
                }
            }
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(title))
                .setSubtitle(activity.getString(R.string.security_prompt_subtitle))
                .setAllowedAuthenticators(authenticators)
                .setNegativeButtonText(activity.getString(R.string.security_cancel))
                .build()
            try {
                if (cryptoObject == null) prompt.authenticate(info) else prompt.authenticate(info, cryptoObject)
            } catch (_: Exception) {
                removeObserver()
                if (continuation.isActive) continuation.resumeWithException(
                    AuthenticationException(AuthenticationFailure.FAILED),
                )
            }
        }
    }
}
