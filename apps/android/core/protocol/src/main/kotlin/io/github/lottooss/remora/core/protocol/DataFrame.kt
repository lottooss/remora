package io.github.lottooss.remora.core.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

const val DATA_FRAME_TYPE: Int = 0x01
const val RLY_VERSION: Int = 1
const val RLY_SUBPROTOCOL: String = "remora.rly.v1"

enum class PeerKind(val value: Int) {
    HOST(0x01),
    DEVICE(0x02);

    companion object {
        fun fromValue(value: Int): PeerKind = when (value) {
            0x01 -> HOST
            0x02 -> DEVICE
            else -> throw DataFrameException("Invalid peer kind: $value")
        }
    }
}

class DataFrameException(message: String) : RuntimeException(message)

data class DataFrame(
    val version: Int,
    val type: Int,
    val channel: Long,
    val peerKind: PeerKind,
    val peerId: ByteArray,
    val payload: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false

        other as DataFrame
        if (version != other.version) return false
        if (type != other.type) return false
        if (channel != other.channel) return false
        if (peerKind != other.peerKind) return false
        if (!peerId.contentEquals(other.peerId)) return false
        if (!payload.contentEquals(other.payload)) return false
        return true
    }

    override fun hashCode(): Int {
        var result = version
        result = 31 * result + type
        result = 31 * result + channel.hashCode()
        result = 31 * result + peerKind.hashCode()
        result = 31 * result + peerId.contentHashCode()
        result = 31 * result + payload.contentHashCode()
        return result
    }
}

fun encodeDataFrame(
    channel: Long,
    peerKind: PeerKind,
    peerId: ByteArray,
    payload: ByteArray,
): ByteArray {
    if (peerId.size != 16) {
        throw DataFrameException("peerId must be exactly 16 bytes, got ${peerId.size}")
    }
    val totalLength = Limits.DATA_FRAME_HEADER_BYTES + payload.size
    if (totalLength > Limits.MAX_DATA_FRAME_BYTES) {
        throw DataFrameException("DataFrame total size ($totalLength) exceeds maximum limit (${Limits.MAX_DATA_FRAME_BYTES})")
    }

    val buffer = ByteBuffer.allocate(totalLength).order(ByteOrder.BIG_ENDIAN)
    // Byte 0: version
    buffer.put(RLY_VERSION.toByte())
    // Byte 1: type
    buffer.put(DATA_FRAME_TYPE.toByte())
    // Bytes 2-3: reserved
    buffer.putShort(0.toShort())
    // Bytes 4-7: channel (u32)
    buffer.putInt((channel and 0xffffffffL).toInt())
    // Byte 8: peer kind
    buffer.put(peerKind.value.toByte())
    // Bytes 9-24: peer id
    buffer.put(peerId)
    // Bytes 25-27: reserved
    buffer.put(0.toByte())
    buffer.put(0.toByte())
    buffer.put(0.toByte())
    // Bytes 28+: payload
    buffer.put(payload)

    return buffer.array()
}

fun decodeDataFrame(bytes: ByteArray): DataFrame {
    if (bytes.size < Limits.DATA_FRAME_HEADER_BYTES) {
        throw DataFrameException("DataFrame too short: ${bytes.size} bytes (minimum ${Limits.DATA_FRAME_HEADER_BYTES})")
    }
    if (bytes.size > Limits.MAX_DATA_FRAME_BYTES) {
        throw DataFrameException("DataFrame exceeds maximum size: ${bytes.size} bytes (maximum ${Limits.MAX_DATA_FRAME_BYTES})")
    }

    val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
    val version = buffer.get().toInt() and 0xff
    if (version != RLY_VERSION) {
        throw DataFrameException("Unsupported protocol version: $version")
    }

    val type = buffer.get().toInt() and 0xff
    if (type != DATA_FRAME_TYPE) {
        throw DataFrameException("Unsupported frame type: $type")
    }

    // Skip reserved 2 bytes
    buffer.getShort()
    val channel = buffer.getInt().toLong() and 0xffffffffL
    val rawPeerKind = buffer.get().toInt() and 0xff
    val peerKind = PeerKind.fromValue(rawPeerKind)

    val peerId = ByteArray(16)
    buffer.get(peerId)

    // Skip reserved 3 bytes
    buffer.get()
    buffer.get()
    buffer.get()

    val payload = ByteArray(bytes.size - Limits.DATA_FRAME_HEADER_BYTES)
    buffer.get(payload)

    return DataFrame(
        version = version,
        type = type,
        channel = channel,
        peerKind = peerKind,
        peerId = peerId,
        payload = payload,
    )
}
