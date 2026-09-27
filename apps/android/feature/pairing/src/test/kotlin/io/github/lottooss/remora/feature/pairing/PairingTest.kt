package io.github.lottooss.remora.feature.pairing

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.PairingFlowState
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

        state = PairingFlowState.Error("Expired")
        assertThat(state).isInstanceOf(PairingFlowState.Error::class.java)
    }
}
