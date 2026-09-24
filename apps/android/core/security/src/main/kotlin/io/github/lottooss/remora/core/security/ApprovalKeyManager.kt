package io.github.lottooss.remora.core.security

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricPrompt
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

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
class ApprovalKeyManager(private val context: Context? = null) {

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }
    }

    fun getOrCreateApprovalKey(hostId: String): ApprovalKeyInfo {
        val alias = Security.approvalKeyAlias(hostId)
        if (keyStore.containsAlias(alias)) {
            val cert = keyStore.getCertificate(alias)
            if (cert != null) {
                return ApprovalKeyInfo(
                    alias = alias,
                    publicKeySpkiDer = cert.publicKey.encoded,
                    isHardwareBacked = true,
                )
            }
        }

        val hasStrongBox = context?.packageManager?.hasSystemFeature(
            PackageManager.FEATURE_STRONGBOX_KEYSTORE,
        ) ?: false

        val kpg = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            KEYSTORE_PROVIDER,
        )

        var isHardware = true
        try {
            val specBuilder = createSpecBuilder(alias, useStrongBox = hasStrongBox)
            kpg.initialize(specBuilder.build())
            kpg.generateKeyPair()
        } catch (e: Exception) {
            if (hasStrongBox) {
                // Fallback to standard TEE if StrongBox is unavailable or fails
                val fallbackSpec = createSpecBuilder(alias, useStrongBox = false)
                kpg.initialize(fallbackSpec.build())
                kpg.generateKeyPair()
            } else {
                throw e
            }
        }

        val cert = keyStore.getCertificate(alias)
            ?: throw IllegalStateException("Keystore certificate missing after generation for $alias")

        return ApprovalKeyInfo(
            alias = alias,
            publicKeySpkiDer = cert.publicKey.encoded,
            isHardwareBacked = isHardware,
        )
    }

    fun createCryptoObject(hostId: String): BiometricPrompt.CryptoObject {
        val alias = Security.approvalKeyAlias(hostId)
        val privateKey = keyStore.getKey(alias, null) as? PrivateKey
            ?: throw IllegalStateException("Approval private key not found for host $hostId")

        val signature = Signature.getInstance(SIGNATURE_ALGORITHM)
        signature.initSign(privateKey)
        return BiometricPrompt.CryptoObject(signature)
    }

    fun isKeyValid(hostId: String): Boolean {
        val alias = Security.approvalKeyAlias(hostId)
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
        val alias = Security.approvalKeyAlias(hostId)
        if (keyStore.containsAlias(alias)) {
            keyStore.deleteEntry(alias)
        }
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
