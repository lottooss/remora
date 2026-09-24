package io.github.lottooss.remora.core.crypto

import com.google.common.truth.Truth.assertThat
import org.junit.Test

class CryptoTest {
    @Test fun namesTheNoiseProtocolExactly() {
        assertThat(Crypto.NOISE_PROTOCOL_NAME).isEqualTo("Noise_IKpsk2_25519_ChaChaPoly_SHA256")
        assertThat(Crypto.DOMAIN_PREFIX).isEqualTo("remora/1")
    }
}
