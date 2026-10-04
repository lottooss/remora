package io.github.lottooss.remora.core.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.KeyInfo
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricPrompt
import java.security.KeyPairGenerator
import java.security.KeyFactory
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.MessageDigest
import java.security.spec.ECGenParameterSpec
import java.util.UUID

data class ApprovalKeyInfo(
    val alias: String,
    val publicKeySpkiDer: ByteArray,
    val isHardwareBacked: Boolean,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as ApprovalKeyInfo
        return alias == other.alias &&
            publicKeySpkiDer.contentEquals(other.publicKeySpkiDer) &&
            isHardwareBacked == other.isHardwareBacked
    }

    override fun hashCode(): Int {
        var result = alias.hashCode()
        result = 31 * result + publicKeySpkiDer.contentHashCode()
        result = 31 * result + isHardwareBacked.hashCode()
        return result
    }
}

/**
 * Manages biometric-bound hardware-backed EC P-256 approval keys in Android Keystore
 * per Crypto/1 §7 and spike P0-S5.
 */
class ApprovalKeyManager(private val context: Context) {

    private val aliases by lazy { context.applicationContext.getSharedPreferences("remora_approval_aliases", Context.MODE_PRIVATE) }

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    }

    fun getOrCreateApprovalKey(hostId: String): ApprovalKeyInfo {
        val alias = activeAlias(hostId)
        return getOrCreateKey(alias)
    }

    private fun getOrCreateKey(alias: String): ApprovalKeyInfo {
        if (keyStore.containsAlias(alias)) {
            val cert = keyStore.getCertificate(alias)
            if (cert != null) {
                return ApprovalKeyInfo(
                    alias = alias,
                    publicKeySpkiDer = cert.publicKey.encoded,
                    isHardwareBacked = isHardwareBacked(alias),
                )
            }
        }

        val hasStrongBox = context.packageManager.hasSystemFeature(
            PackageManager.FEATURE_STRONGBOX_KEYSTORE,
        )

        val kpg = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            KEYSTORE_PROVIDER,
        )

        try {
            val specBuilder = createSpecBuilder(alias, useStrongBox = hasStrongBox)
            kpg.initialize(specBuilder.build())
            kpg.generateKeyPair()
        } catch (e: StrongBoxUnavailableException) {
            if (hasStrongBox) {
                // StrongBox is optional; per-use biometric policy stays identical.
                val fallbackSpec = createSpecBuilder(alias, useStrongBox = false)
                kpg.initialize(fallbackSpec.build())
                kpg.generateKeyPair()
            } else {
                throw e
            }
        }

        val cert = keyStore.getCertificate(alias)
            ?: throw IllegalStateException("Approval certificate is unavailable")

        return ApprovalKeyInfo(
            alias = alias,
            publicKeySpkiDer = cert.publicKey.encoded,
            isHardwareBacked = isHardwareBacked(alias),
        )
    }

    fun createCryptoObject(hostId: String): BiometricPrompt.CryptoObject {
        val alias = activeAlias(hostId)
        val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            ?: throw IllegalStateException("Approval key is unavailable")

        val signature = Signature.getInstance(SIGNATURE_ALGORITHM)
        signature.initSign(privateKey)
        return BiometricPrompt.CryptoObject(signature)
    }

    fun isKeyValid(hostId: String): Boolean {
        val alias = activeAlias(hostId)
        return try {
            if (!keyStore.containsAlias(alias)) return false
            val privateKey = keyStore.getKey(alias, null) as? PrivateKey ?: return false
            val sig = Signature.getInstance(SIGNATURE_ALGORITHM)
            sig.initSign(privateKey)
            true
        } catch (_: KeyPermanentlyInvalidatedException) {
            false
        } catch (_: Exception) {
            false
        }
    }

    fun deleteApprovalKey(hostId: String) {
        val base = Security.approvalKeyAlias(hostId)
        val entries = keyStore.aliases().toList().filter { it == base || it.startsWith(base + "_pending_") }
        entries.forEach { keyStore.deleteEntry(it) }
        check(aliases.edit().remove("active_$hostId").remove("pending_$hostId").commit()) {
            "Approval key removal failed"
        }
    }

    /** Generates a candidate without replacing the host's currently registered signing key. */
    fun createPendingApprovalKey(hostId: String): ApprovalKeyInfo {
        pendingApprovalKey(hostId)?.let { return it }
        val alias = Security.approvalKeyAlias(hostId) + "_pending_" + UUID.randomUUID()
        val info = getOrCreateKey(alias)
        if (!aliases.edit().putString("pending_$hostId", alias).commit()) {
            keyStore.deleteEntry(alias)
            throw IllegalStateException("Approval key persistence failed")
        }
        return info
    }

    /** Reads a candidate across process restarts without silently regenerating it. */
    fun pendingApprovalKey(hostId: String): ApprovalKeyInfo? {
        val alias = aliases.getString("pending_$hostId", null) ?: return null
        checkedAlias(hostId, alias)
        val certificate = keyStore.getCertificate(alias)
            ?: throw IllegalStateException("Pending approval key is unavailable")
        return ApprovalKeyInfo(alias, certificate.publicKey.encoded, isHardwareBacked(alias))
    }

    /** Activate only after the owner confirms the pending change on the PC. */
    fun activatePendingApprovalKey(hostId: String, expectedPublicKeySpkiDer: ByteArray) {
        val pending = aliases.getString("pending_$hostId", null)
            ?: throw IllegalStateException("No pending approval key")
        checkedAlias(hostId, pending)
        val actual = keyStore.getCertificate(pending)?.publicKey?.encoded
            ?: throw IllegalStateException("Pending approval key is unavailable")
        check(MessageDigest.isEqual(actual, expectedPublicKeySpkiDer)) { "Approval key mismatch" }
        val previous = activeAlias(hostId)
        check(aliases.edit().putString("active_$hostId", pending).remove("pending_$hostId").commit()) {
            "Approval key persistence failed"
        }
        if (previous != pending && keyStore.containsAlias(previous)) keyStore.deleteEntry(previous)
    }

    /** Cancels only the unregistered candidate, preserving the active signing key. */
    fun discardPendingApprovalKey(hostId: String) {
        val pending = aliases.getString("pending_$hostId", null) ?: return
        checkedAlias(hostId, pending)
        check(pending != activeAlias(hostId)) { "Cannot remove active approval key" }
        keyStore.deleteEntry(pending)
        check(aliases.edit().remove("pending_$hostId").commit()) { "Approval key removal failed" }
    }

    private fun activeAlias(hostId: String): String = checkedAlias(hostId,
        aliases.getString("active_$hostId", null) ?: Security.approvalKeyAlias(hostId))

    private fun checkedAlias(hostId: String, alias: String): String {
        val base = Security.approvalKeyAlias(hostId)
        require(alias == base || alias.startsWith(base + "_pending_")) { "Invalid approval key alias" }
        return alias
    }

    private fun isHardwareBacked(alias: String): Boolean {
        val key = keyStore.getKey(alias, null) as? PrivateKey
            ?: throw IllegalStateException("Approval key is unavailable")
        val info = KeyFactory.getInstance(key.algorithm, KEYSTORE_PROVIDER)
            .getKeySpec(key, KeyInfo::class.java)
        @Suppress("DEPRECATION")
        return info.isInsideSecureHardware
    }

    private fun createSpecBuilder(alias: String, useStrongBox: Boolean): KeyGenParameterSpec.Builder {
        val builder = KeyGenParameterSpec.Builder(
            alias,
            KeyProperties.PURPOSE_SIGN,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(-1)
        }

        if (useStrongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }

        return builder
    }

    companion object {
        private const val KEYSTORE_PROVIDER = "AndroidKeyStore"
        private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    }
}
