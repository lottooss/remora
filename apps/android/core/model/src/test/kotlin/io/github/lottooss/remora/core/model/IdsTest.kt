package io.github.lottooss.remora.core.model

import com.google.common.truth.Truth.assertThat
import org.junit.Assert.assertThrows
import org.junit.Test

class IdsTest {
    @Test fun acceptsWellFormedIds() {
        assertThat(HostId("h_" + "a".repeat(26)).value).startsWith("h_")
        assertThat(DeviceId("d_" + "b".repeat(26)).value).startsWith("d_")
    }

    @Test fun rejectsWrongPrefixOrLength() {
        assertThrows(IllegalArgumentException::class.java) { HostId("d_" + "a".repeat(26)) }
        assertThrows(IllegalArgumentException::class.java) { DeviceId("d_short") }
    }
}
