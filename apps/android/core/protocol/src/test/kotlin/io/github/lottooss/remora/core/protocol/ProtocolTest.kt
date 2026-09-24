package io.github.lottooss.remora.core.protocol

import com.google.common.truth.Truth.assertThat
import java.io.File
import kotlinx.serialization.json.Json
import org.junit.Test

class ProtocolTest {
    @Test fun constantsMatchTheTypeScriptPackage() {
        assertThat(Protocol.MAX_RCP_MESSAGE_BYTES).isEqualTo(48 * 1024)
        assertThat(Protocol.RLY_SUBPROTOCOL).isEqualTo("remora.rly.v1")
    }

    @Test fun serializesPing() {
        assertThat(Json.encodeToString(PingParams.serializer(), PingParams(42))).isEqualTo("{\"t\":42}")
    }

    @Test fun seesTheSharedConformanceDirectory() {
        val dir = File(System.getProperty("remora.conformance.dir"))
        assertThat(File(dir, "README.md").isFile).isTrue()
    }
}
