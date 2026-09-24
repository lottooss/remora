package io.github.lottooss.remora.spike.approvalkey

import android.os.Build
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import java.security.KeyStore
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** Summary of one certificate in the attestation chain (or the self-signed leaf). */
data class CertInfo(
    val subject: String,
    val issuer: String,
    val serial: String,
    val notBefore: String,
    val notAfter: String,
    val publicKey: String,
) {
    val isRoot: Boolean get() = subject == issuer
}

/** Outcome of one key-generation attempt. */
data class CreateOutcome(
    val spki: ByteArray,
    val chain: List<CertInfo>,
    val strongBoxUsed: Boolean,
    val strongBoxError: String?,
    val keygenMs: Long,
)

/** Result of probing whether the key still exists and still needs per-use auth. */
sealed interface KeyProbe {
    /** Key is valid; a direct [Signature.sign] without biometric was refused. */
    data object NeedsAuth : KeyProbe

    /** Key was invalidated (e.g. new fingerprint enrolled). */
    data object Invalidated : KeyProbe

    /** Direct sign succeeded without any biometric — the gate would be broken. */
    data object SignableWithoutAuth : KeyProbe

    data class Error(val detail: String) : KeyProbe
}

/**
 * Android Keystore lifecycle for the spike approval key: EC P-256,
 * `SHA256withECDSA`, per-use `BIOMETRIC_STRONG` (API 30+; API 28–29 cannot
 * express the authenticator set), `setInvalidatedByBiometricEnrollment(true)`,
 * StrongBox when the device offers it, attestation challenge on creation.
 */
object ApprovalKeys {
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "remora_approval_spike"
    const val KEY_ALGORITHM = "EC"
    const val SIGNATURE_ALGORITHM = "SHA256withECDSA"

    fun exists(): Boolean = keyStore().containsAlias(ALIAS)

    fun delete() {
        if (exists()) keyStore().deleteEntry(ALIAS)
    }

    /**
     * Generates the approval key. When [preferStrongBox] is set, StrongBox is
     * attempted first; any StrongBox failure (device has none, or the platform
     * rejects the spec) is recorded and the key is generated in the TEE
     * instead so the spike remains runnable. Throws if both attempts fail.
     */
    fun create(preferStrongBox: Boolean = true): CreateOutcome {
        delete()
        var strongBoxError: String? = null
        if (preferStrongBox) {
            try {
                return generate(strongBox = true, strongBoxError = null)
            } catch (t: Throwable) {
                strongBoxError = "${t.javaClass.simpleName}: ${t.message}"
                runCatching { delete() }
            }
        }
        return generate(strongBox = false, strongBoxError = strongBoxError)
    }

    /** base64url (no padding) SubjectPublicKeyInfo DER of the public key. */
    fun spkiB64u(): String? = keyStore().let { ks ->
        if (!ks.containsAlias(ALIAS)) null
        else ks.getCertificate(ALIAS).publicKey.encoded.toB64u()
    }

    /** Attestation chain when the key was created with a challenge; else the self-signed leaf. */
    fun attestationChain(): List<CertInfo> {
        val chain = keyStore().getCertificateChain(ALIAS) ?: return emptyList()
        return chain.map { certInfo(it as X509Certificate) }
    }

    /**
     * Initializes a JCA signer bound to the Keystore key. Must be called before
     * `BiometricPrompt.authenticate(info, CryptoObject(signature))`; the actual
     * private-key operation runs only after a successful authentication.
     */
    fun newSigner(): Signature {
        val privateKey = keyStore().getKey(ALIAS, null) as? PrivateKey
            ?: throw IllegalStateException("approval key $ALIAS not found")
        val signature = Signature.getInstance(SIGNATURE_ALGORITHM)
        signature.initSign(privateKey)
        return signature
    }

    /** Classifies a direct, non-biometric sign attempt (acceptance evidence). */
    fun probe(): KeyProbe {
        val signer = try {
            newSigner()
        } catch (t: Throwable) {
            return classify(t)
        }
        return try {
            signer.update(byteArrayOf(0x00))
            signer.sign()
            KeyProbe.SignableWithoutAuth
        } catch (t: Throwable) {
            classify(t)
        }
    }

    private fun generate(strongBox: Boolean, strongBoxError: String?): CreateOutcome {
        val builder = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_SIGN,
        )
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        } else {
            @Suppress("DEPRECATION")
            builder.setUserAuthenticationValidityDurationSeconds(0)
        }
        if (strongBox) builder.setIsStrongBoxBacked(true)
        val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
        builder.setAttestationChallenge(challenge)

        val startedAt = SystemClock.elapsedRealtime()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(builder.build())
        generator.generateKeyPair()
        val keygenMs = SystemClock.elapsedRealtime() - startedAt

        val ks = keyStore()
        val spki = ks.getCertificate(ALIAS).publicKey.encoded
        val chain = (ks.getCertificateChain(ALIAS) ?: emptyArray())
            .map { certInfo(it as X509Certificate) }
        return CreateOutcome(
            spki = spki,
            chain = chain,
            strongBoxUsed = strongBox,
            strongBoxError = strongBoxError,
            keygenMs = keygenMs,
        )
    }

    private fun classify(t: Throwable): KeyProbe {
        var current: Throwable? = t
        while (current != null) {
            val name = current.javaClass.name
            if (current is UserNotAuthenticatedException || name.contains("UserNotAuthenticated")) {
                return KeyProbe.NeedsAuth
            }
            if (current is KeyPermanentlyInvalidatedException || name.contains("KeyPermanentlyInvalidated")) {
                return KeyProbe.Invalidated
            }
            current = current.cause
        }
        return KeyProbe.Error("${t.javaClass.name}: ${t.message}")
    }

    private fun certInfo(cert: X509Certificate): CertInfo = CertInfo(
        subject = cert.subjectX500Principal.name,
        issuer = cert.issuerX500Principal.name,
        serial = cert.serialNumber.toString(16),
        notBefore = iso(cert.notBefore),
        notAfter = iso(cert.notAfter),
        publicKey = "${cert.publicKey.algorithm} ${cert.publicKey.format?.length ?: 0}B SPKI",
    )

    private fun iso(date: Date): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
            timeZone = java.util.TimeZone.getTimeZone("UTC")
        }.format(date)

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
}

/** base64url without padding (RFC 4648 §5), the wire encoding for keys and signatures. */
fun ByteArray.toB64u(): String =
    Base64.encodeToString(this, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
