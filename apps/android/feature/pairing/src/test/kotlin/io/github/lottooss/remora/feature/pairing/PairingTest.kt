package io.github.lottooss.remora.feature.pairing

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.PairingFlowState
import io.github.lottooss.remora.core.data.PairingError
import io.github.lottooss.remora.core.data.validatePairingPayload
import org.junit.Test

class PairingTest {

    @Test
    fun testPairingStateTransitions() {
        var state: PairingFlowState = PairingFlowState.Idle
        assertThat(state).isEqualTo(PairingFlowState.Idle)

        state = PairingFlowState.Enrolling("DESKTOP-OLSI")
        assertThat(state).isInstanceOf(PairingFlowState.Enrolling::class.java)
        assertThat((state as PairingFlowState.Enrolling).hostName).isEqualTo("DESKTOP-OLSI")

        state = PairingFlowState.ConfirmingSas("482 193", "DESKTOP-OLSI")
        assertThat(state).isInstanceOf(PairingFlowState.ConfirmingSas::class.java)
        val sasState = state as PairingFlowState.ConfirmingSas
        assertThat(sasState.sasCode).isEqualTo("482 193")
        assertThat(sasState.hostName).isEqualTo("DESKTOP-OLSI")

        state = PairingFlowState.Success("h_test1234567890123456789012", "DESKTOP-OLSI")
        assertThat(state).isInstanceOf(PairingFlowState.Success::class.java)

        state = PairingFlowState.Error(PairingError.EXPIRED_QR)
        assertThat(state).isInstanceOf(PairingFlowState.Error::class.java)
    }

    private fun qr(version: Int = 1, relay: String = "https%3A%2F%2Frelay.example", expiry: Long = 1100): String =
        "remora://pair?v=$version&r=$relay&h=h_aaaaaaaaaaaaaaaaaaaaaaaaaa" +
            "&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
            "&t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
            "&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&n=PC&x=$expiry"

    @Test fun validQrAccepted() {
        assertThat(validatePairingPayload(qr(), 1000)).isNull()
    }

    @Test fun expiredQrRejected() {
        assertThat(validatePairingPayload(qr(expiry = 1000), 1000)).isEqualTo(PairingError.EXPIRED_QR)
    }

    @Test fun wrongVersionRejected() {
        assertThat(validatePairingPayload(qr(version = 2), 1000)).isEqualTo(PairingError.INVALID_QR)
    }

    @Test fun cleartextLoopbackRejected() {
        assertThat(validatePairingPayload(qr(relay = "http%3A%2F%2F127.0.0.1"), 1000))
            .isEqualTo(PairingError.INSECURE_RELAY)
    }

    @Test fun relayCredentialsAndQueriesRejected() {
        assertThat(validatePairingPayload(qr(relay = "https%3A%2F%2Fuser%40relay.example"), 1000))
            .isEqualTo(PairingError.INVALID_QR)
        assertThat(validatePairingPayload(qr(relay = "https%3A%2F%2Frelay.example%3Fx%3D1"), 1000))
            .isEqualTo(PairingError.INVALID_QR)
    }
}
