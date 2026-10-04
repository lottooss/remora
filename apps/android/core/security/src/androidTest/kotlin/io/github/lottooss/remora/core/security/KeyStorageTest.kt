package io.github.lottooss.remora.core.security

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry

@RunWith(AndroidJUnit4::class)
class KeyStorageTest {

    @Test
    fun testSaveAndRetrieveHostKeys() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val storage = SecureKeyStorage(context)

        val keys = HostKeyMaterial(
            hostId = "h_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            deviceId = "d_bbbbbbbbbbbbbbbbbbbbbbbbbb",
            relayPrivKey = ByteArray(32) { 0x11 },
            relayPubKey = ByteArray(32) { 0x22 },
            noisePrivKey = ByteArray(32) { 0x33 },
            noisePubKey = ByteArray(32) { 0x44 },
            devicePsk = ByteArray(32) { 0x55 },
            pushKey = ByteArray(32) { 0x66 },
            approvalPubSpki = ByteArray(91) { 0x77 },
        )

        storage.saveHostKeys(keys.hostId, keys)

        // A new instance must open the persisted, Keystore-wrapped Tink keyset.
        val retrieved = SecureKeyStorage(context).getHostKeys(keys.hostId)
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

        storage.wipeHost(keys.hostId)
        val afterDelete = SecureKeyStorage(context).getHostKeys(keys.hostId)
        assertThat(afterDelete).isNull()
    }
}
