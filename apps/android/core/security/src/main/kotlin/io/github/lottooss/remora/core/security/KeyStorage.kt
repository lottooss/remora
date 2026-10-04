package io.github.lottooss.remora.core.security

import android.content.Context
import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.aead.AeadConfig
import com.google.crypto.tink.integration.android.AndroidKeysetManager
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import com.google.crypto.tink.integration.android.SharedPrefKeysetReader
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.security.KeyStore

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
    context: Context,
    private val approvalKeyManager: ApprovalKeyManager = ApprovalKeyManager(context),
) : KeyStorage {
    private val appContext = context.applicationContext
    private val prefs by lazy { appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE) }
    private val aead: Aead by lazy {
        synchronized(KEYSET_LOCK) {
            AeadConfig.register()
            // Pre-create and open the master key: Tink's opportunistic cleartext fallback
            // must never be used, including while creating the very first keyset.
            val hasKeyset = appContext.getSharedPreferences(KEYSET_PREFS, Context.MODE_PRIVATE)
                .contains(KEYSET_NAME)
            val masterExists = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                .containsAlias(Security.MASTER_KEY_URI.removePrefix("android-keystore://"))
            check(!hasKeyset || masterExists) { "Secure storage master key is missing" }
            if (!masterExists) AndroidKeystoreKmsClient.generateNewAeadKey(Security.MASTER_KEY_URI)
            AndroidKeystoreKmsClient().getAead(Security.MASTER_KEY_URI)
            if (hasKeyset) {
                val encrypted = SharedPrefKeysetReader(appContext, KEYSET_NAME, KEYSET_PREFS).readEncrypted()
                check(!encrypted.encryptedKeyset.isEmpty) { "Secure keyset is not encrypted" }
            }
            val manager = AndroidKeysetManager.Builder()
                .withSharedPref(appContext, KEYSET_NAME, KEYSET_PREFS)
                .withKeyTemplate(KeyTemplates.get("AES256_GCM"))
                .withMasterKeyUri(Security.MASTER_KEY_URI)
                .build()
            check(manager.isUsingKeystore) { "Secure storage is unavailable" }
            manager.keysetHandle.getPrimitive(Aead::class.java)
        }
    }

    override suspend fun saveHostKeys(hostId: String, keys: HostKeyMaterial) = withContext(Dispatchers.IO) {
        require(hostId == keys.hostId) { "Key identity mismatch" }
        val plaintext = HostKeyCodec.encode(keys)
        try {
            val encrypted = aead.encrypt(plaintext, associatedData(hostId))
            check(prefs.edit().putString(PREF_KEY_PREFIX + hostId, encodeBase64Url(encrypted)).commit()) {
                "Secure storage write failed"
            }
        } finally {
            plaintext.fill(0)
        }
    }

    override suspend fun getHostKeys(hostId: String): HostKeyMaterial? = withContext(Dispatchers.IO) {
        val encrypted = prefs.getString(PREF_KEY_PREFIX + hostId, null) ?: return@withContext null
        // Corruption or lost Keystore keys are errors, never an apparently unpaired host.
        val plaintext = try {
            aead.decrypt(decodeBase64Url(encrypted), associatedData(hostId))
        } catch (_: Exception) {
            throw KeyStorageException()
        }
        try {
            HostKeyCodec.decode(hostId, plaintext)
        } finally {
            plaintext.fill(0)
        }
    }

    override suspend fun deleteHostKeys(hostId: String) = withContext(Dispatchers.IO) {
        check(prefs.edit().remove(PREF_KEY_PREFIX + hostId).commit()) {
            "Secure storage removal failed"
        }
    }

    override suspend fun wipeHost(hostId: String) = withContext(Dispatchers.IO) {
        deleteHostKeys(hostId)
        approvalKeyManager.deleteApprovalKey(hostId)
    }

    private fun associatedData(hostId: String): ByteArray =
        "remora/1 host-keys\u0000$hostId".toByteArray(Charsets.UTF_8)

    companion object {
        private val KEYSET_LOCK = Any()
        private const val PREFS_NAME = "remora_keys_storage"
        private const val PREF_KEY_PREFIX = "host_keys_"
        private const val KEYSET_PREFS = "remora_tink_keyset"
        private const val KEYSET_NAME = "host_keys_aead_v1"
    }
}

/** Intentionally excludes provider exceptions, which may contain sensitive input. */
class KeyStorageException : IllegalStateException("Stored pairing keys cannot be read; pair again")

/** Bounded binary serialization avoids retaining private material in immutable strings. */
internal object HostKeyCodec {
    fun encode(keys: HostKeyMaterial): ByteArray {
        require(keys.deviceId.matches(Regex("d_[a-z2-7]{26}"))) { "Invalid device identity" }
        val output = WipingByteArrayOutputStream()
        try {
            DataOutputStream(output).use { data ->
                data.writeInt(1)
                data.writeUTF(keys.deviceId)
                listOf(keys.relayPrivKey, keys.relayPubKey, keys.noisePrivKey, keys.noisePubKey,
                    keys.devicePsk, keys.pushKey, keys.approvalPubSpki).forEachIndexed { index, key ->
                    require(if (index < 6) key.size == 32 else key.size in 1..512) { "Invalid key material" }
                    data.writeInt(key.size)
                    data.write(key)
                }
            }
            return output.toByteArray()
        } finally {
            output.wipe()
        }
    }

    fun decode(hostId: String, bytes: ByteArray): HostKeyMaterial {
        val material = mutableListOf<ByteArray>()
        try {
            require(bytes.size <= 4096)
            return DataInputStream(ByteArrayInputStream(bytes)).use { data ->
                require(data.readInt() == 1)
                val deviceId = data.readUTF()
                require(deviceId.matches(Regex("d_[a-z2-7]{26}")))
                repeat(7) { index ->
                    val length = data.readInt()
                    require(if (index < 6) length == 32 else length in 1..512)
                    val part = ByteArray(length)
                    material += part
                    data.readFully(part)
                }
                require(data.available() == 0)
                HostKeyMaterial(hostId, deviceId, material[0], material[1], material[2],
                    material[3], material[4], material[5], material[6])
            }
        } catch (_: Exception) {
            material.forEach { it.fill(0) }
            throw KeyStorageException()
        }
    }

    private class WipingByteArrayOutputStream : ByteArrayOutputStream(4096) {
        fun wipe() { buf.fill(0) }
    }
}
