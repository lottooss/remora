package io.github.lottooss.remora.core.security

import android.content.Context
import android.content.SharedPreferences
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

data class HostKeyMaterial(
    val hostId: String,
    val deviceId: String,
    val relayPrivKey: ByteArray,
    val relayPubKey: ByteArray,
    val noisePrivKey: ByteArray,
    val noisePubKey: ByteArray,
    val devicePsk: ByteArray,
    val pushKey: ByteArray,
    val approvalPubSpki: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as HostKeyMaterial
        return hostId == other.hostId &&
            deviceId == other.deviceId &&
            relayPrivKey.contentEquals(other.relayPrivKey) &&
            relayPubKey.contentEquals(other.relayPubKey) &&
            noisePrivKey.contentEquals(other.noisePrivKey) &&
            noisePubKey.contentEquals(other.noisePubKey) &&
            devicePsk.contentEquals(other.devicePsk) &&
            pushKey.contentEquals(other.pushKey) &&
            approvalPubSpki.contentEquals(other.approvalPubSpki)
    }

    override fun hashCode(): Int {
        var result = hostId.hashCode()
        result = 31 * result + deviceId.hashCode()
        result = 31 * result + relayPrivKey.contentHashCode()
        result = 31 * result + relayPubKey.contentHashCode()
        result = 31 * result + noisePrivKey.contentHashCode()
        result = 31 * result + noisePubKey.contentHashCode()
        result = 31 * result + devicePsk.contentHashCode()
        result = 31 * result + pushKey.contentHashCode()
        result = 31 * result + approvalPubSpki.contentHashCode()
        return result
    }

    fun wipe() {
        relayPrivKey.fill(0)
        noisePrivKey.fill(0)
        devicePsk.fill(0)
        pushKey.fill(0)
    }
}

interface KeyStorage {
    suspend fun saveHostKeys(hostId: String, keys: HostKeyMaterial)
    suspend fun getHostKeys(hostId: String): HostKeyMaterial?
    suspend fun deleteHostKeys(hostId: String)
    suspend fun wipeHost(hostId: String)
}

/**
 * Storage for per-host key material encrypted at rest with AEAD (Crypto/1 §9).
 * Wipes sensitive memory and entries upon unpair/revocation.
 */
class SecureKeyStorage(
    private val context: Context? = null,
    private val approvalKeyManager: ApprovalKeyManager = ApprovalKeyManager(context),
    private val masterSecretKey: ByteArray? = null,
) : KeyStorage {

    private val inMemoryStore = ConcurrentHashMap<String, String>()
    private val prefs: SharedPreferences? by lazy {
        context?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }
    private val storageKey: ByteArray by lazy {
        masterSecretKey ?: run {
            val key = ByteArray(32)
            SecureRandom().nextBytes(key)
            key
        }
    }

    override suspend fun saveHostKeys(hostId: String, keys: HostKeyMaterial) {
        val plaintext = serializeKeyMaterial(keys)
        val encrypted = encryptPayload(plaintext)
        if (prefs != null) {
            prefs!!.edit().putString(PREF_KEY_PREFIX + hostId, encrypted).apply()
        } else {
            inMemoryStore[PREF_KEY_PREFIX + hostId] = encrypted
        }
    }

    override suspend fun getHostKeys(hostId: String): HostKeyMaterial? {
        val encrypted = if (prefs != null) {
            prefs!!.getString(PREF_KEY_PREFIX + hostId, null)
        } else {
            inMemoryStore[PREF_KEY_PREFIX + hostId]
        } ?: return null

        val plaintext = decryptPayload(encrypted) ?: return null
        return deserializeKeyMaterial(hostId, plaintext)
    }

    override suspend fun deleteHostKeys(hostId: String) {
        if (prefs != null) {
            prefs!!.edit().remove(PREF_KEY_PREFIX + hostId).apply()
        } else {
            inMemoryStore.remove(PREF_KEY_PREFIX + hostId)
        }
    }

    override suspend fun wipeHost(hostId: String) {
        deleteHostKeys(hostId)
        approvalKeyManager.deleteApprovalKey(hostId)
    }

    private fun encryptPayload(plaintext: ByteArray): String {
        val nonce = ByteArray(12)
        SecureRandom().nextBytes(nonce)
        val cipher = ChaCha20Poly1305()
        cipher.init(true, ParametersWithIV(KeyParameter(storageKey), nonce))
        val out = ByteArray(plaintext.size + 16)
        val len = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
        cipher.doFinal(out, len)
        return encodeBase64Url(nonce + out)
    }

    private fun decryptPayload(encoded: String): ByteArray? {
        return try {
            val raw = decodeBase64Url(encoded)
            if (raw.size < 28) return null
            val nonce = raw.sliceArray(0 until 12)
            val ciphertext = raw.sliceArray(12 until raw.size)
            val cipher = ChaCha20Poly1305()
            cipher.init(false, ParametersWithIV(KeyParameter(storageKey), nonce))
            val out = ByteArray(ciphertext.size - 16)
            val len = cipher.processBytes(ciphertext, 0, ciphertext.size, out, 0)
            cipher.doFinal(out, len)
            out
        } catch (_: Exception) {
            null
        }
    }

    private fun serializeKeyMaterial(keys: HostKeyMaterial): ByteArray {
        val parts = listOf(
            keys.deviceId,
            encodeBase64Url(keys.relayPrivKey),
            encodeBase64Url(keys.relayPubKey),
            encodeBase64Url(keys.noisePrivKey),
            encodeBase64Url(keys.noisePubKey),
            encodeBase64Url(keys.devicePsk),
            encodeBase64Url(keys.pushKey),
            encodeBase64Url(keys.approvalPubSpki),
        )
        return parts.joinToString("\n").toByteArray(Charsets.UTF_8)
    }

    private fun deserializeKeyMaterial(hostId: String, bytes: ByteArray): HostKeyMaterial? {
        val lines = bytes.toString(Charsets.UTF_8).split("\n")
        if (lines.size < 8) return null
        return HostKeyMaterial(
            hostId = hostId,
            deviceId = lines[0],
            relayPrivKey = decodeBase64Url(lines[1]),
            relayPubKey = decodeBase64Url(lines[2]),
            noisePrivKey = decodeBase64Url(lines[3]),
            noisePubKey = decodeBase64Url(lines[4]),
            devicePsk = decodeBase64Url(lines[5]),
            pushKey = decodeBase64Url(lines[6]),
            approvalPubSpki = decodeBase64Url(lines[7]),
        )
    }

    companion object {
        private const val PREFS_NAME = "remora_keys_storage"
        private const val PREF_KEY_PREFIX = "host_keys_"
    }
}
