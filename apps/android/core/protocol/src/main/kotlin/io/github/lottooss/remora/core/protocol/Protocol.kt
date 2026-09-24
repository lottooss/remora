package io.github.lottooss.remora.core.protocol

import kotlinx.serialization.Serializable

/**
 * Kotlin twin of @remora/protocol (RCP/1 + RLY/1). Implementation: task P1-K1.
 * Must pass exactly the vectors in conformance/vectors/{rcp,relay}.
 */
object Protocol {
    const val RCP_VERSION = 1
    const val RLY_VERSION = 1
    const val MAX_RCP_MESSAGE_BYTES = 49_152
    const val MAX_DATA_FRAME_BYTES = 65_536
    const val DATA_FRAME_HEADER_BYTES = 28
    const val RLY_SUBPROTOCOL = "remora.rly.v1"
}

/** RCP `ping` params (RCP/1 §4); placeholder proving the serialization setup. */
@Serializable
data class PingParams(val t: Long)
