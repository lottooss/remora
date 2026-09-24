package io.github.lottooss.remora.core.security

/**
 * Tink keyset storage (master key URI below), Keystore approval keys, and
 * BiometricPrompt helpers. Implementation: spike P0-S5, tasks P2-K1 and P3-K1.
 */
object Security {
    const val MASTER_KEY_URI = "android-keystore://remora_master_v1"

    fun approvalKeyAlias(hostId: String): String = "remora_approval_$hostId"
}
