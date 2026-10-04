package io.github.lottooss.remora.core.security

/**
 * Shared aliases for encrypted storage and per-host biometric signing keys.
 */
object Security {
    const val MASTER_KEY_URI = "android-keystore://remora_master_v1"

    fun approvalKeyAlias(hostId: String): String {
        require(hostId.matches(Regex("h_[a-z2-7]{26}"))) { "Invalid host identity" }
        return "remora_approval_$hostId"
    }
}
