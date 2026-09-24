package io.github.lottooss.remora.core.security

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test

class KeyStorageTest {

    @Test
    fun testSaveAndRetrieveHostKeys() = runBlocking {
        val storage = SecureKeyStorage(
            masterSecretKey = ByteArray(32) { (it + 1).toByte() },
        )

        val keys = HostKeyMaterial(
            hostId = "h_test1234567890123456789012",
            deviceId = "d_pixel123456789012345678901",
            relayPrivKey = ByteArray(32) { 0x11 },
            relayPubKey = ByteArray(32) { 0x22 },
            noisePrivKey = ByteArray(32) { 0x33 },
            noisePubKey = ByteArray(32) { 0x44 },
            devicePsk = ByteArray(32) { 0x55 },
            pushKey = ByteArray(32) { 0x66 },
            approvalPubSpki = ByteArray(91) { 0x77 },
        )

        storage.saveHostKeys(keys.hostId, keys)

        val retrieved = storage.getHostKeys(keys.hostId)
        assertThat(retrieved).isNotNull()
        assertThat(retrieved!!.hostId).isEqualTo(keys.hostId)
        assertThat(retrieved.deviceId).isEqualTo(keys.deviceId)
        assertThat(retrieved.relayPrivKey).isEqualTo(keys.relayPrivKey)
        assertThat(retrieved.relayPubKey).isEqualTo(keys.relayPubKey)
        assertThat(retrieved.noisePrivKey).isEqualTo(keys.noisePrivKey)
        assertThat(retrieved.noisePubKey).isEqualTo(keys.noisePubKey)
        assertThat(retrieved.devicePsk).isEqualTo(keys.devicePsk)
        assertThat(retrieved.pushKey).isEqualTo(keys.pushKey)
        assertThat(retrieved.approvalPubSpki).isEqualTo(keys.approvalPubSpki)

        storage.deleteHostKeys(keys.hostId)
        val afterDelete = storage.getHostKeys(keys.hostId)
        assertThat(afterDelete).isNull()
    }
}
