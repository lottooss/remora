package io.github.lottooss.remora.core.protocol

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

class ProtocolTest {

    private val conformanceDir by lazy {
        val path = System.getProperty("remora.conformance.dir") ?: "../../conformance"
        File(path).canonicalFile
    }

    private fun loadVector(relativePath: String) =
        Json.parseToJsonElement(File(conformanceDir, "vectors/$relativePath").readText()).jsonObject

    @Test
    fun constantsMatchTheTypeScriptPackage() {
        assertThat(Limits.MAX_RCP_MESSAGE_BYTES).isEqualTo(48 * 1024)
        assertThat(Limits.MAX_DATA_FRAME_BYTES).isEqualTo(64 * 1024)
        assertThat(Limits.DATA_FRAME_HEADER_BYTES).isEqualTo(28)
        assertThat(Limits.MAX_DATA_FRAME_PAYLOAD_BYTES).isEqualTo(64 * 1024 - 28)
        assertThat(Limits.MAX_ENDPOINTS).isEqualTo(32)
        assertThat(Limits.TICKET_TTL_MS).isEqualTo(600_000L)
        assertThat(Limits.AUTH_TIMEOUT_MS).isEqualTo(10_000L)
        assertThat(Limits.HOST_OFFLINE_ALERT_MS).isEqualTo(120_000L)
        assertThat(Limits.RATE_BURST).isEqualTo(100)
        assertThat(Limits.RATE_FRAMES_PER_SEC).isEqualTo(50)
        assertThat(RLY_SUBPROTOCOL).isEqualTo("remora.rly.v1")
        assertThat(RLY_VERSION).isEqualTo(1)
        assertThat(DATA_FRAME_TYPE).isEqualTo(0x01)
    }

    @Test
    fun conformanceVectorFilesArePresent() {
        assertThat(loadVector("rcp/envelope.json")["suite"]!!.jsonPrimitive.content).isEqualTo("rcp/envelope")
        assertThat(loadVector("rcp/limits.json")["suite"]!!.jsonPrimitive.content).isEqualTo("rcp/limits")
        assertThat(loadVector("relay/control-frames.json")["suite"]!!.jsonPrimitive.content).isEqualTo("relay/control-frames")
        assertThat(loadVector("relay/data-frame.json")["suite"]!!.jsonPrimitive.content).isEqualTo("relay/data-frame")
    }

    @Test
    fun rlyDataFrameCodecRoundtrip() {
        val dummyPeerId = ByteArray(16) { (it + 1).toByte() }
        val dummyPayload = byteArrayOf(0xde.toByte(), 0xad.toByte(), 0xbe.toByte(), 0xef.toByte(), 0x42)

        val encoded = encodeDataFrame(
            channel = 42L,
            peerKind = PeerKind.DEVICE,
            peerId = dummyPeerId,
            payload = dummyPayload,
        )

        assertThat(encoded.size).isEqualTo(Limits.DATA_FRAME_HEADER_BYTES + dummyPayload.size)

        val decoded = decodeDataFrame(encoded)
        assertThat(decoded.version).isEqualTo(1)
        assertThat(decoded.type).isEqualTo(1)
        assertThat(decoded.channel).isEqualTo(42L)
        assertThat(decoded.peerKind).isEqualTo(PeerKind.DEVICE)
        assertThat(decoded.peerId).isEqualTo(dummyPeerId)
        assertThat(decoded.payload).isEqualTo(dummyPayload)
    }

    @Test
    fun rlyDataFrameRejectsInvalidInput() {
        val dummyPayload = byteArrayOf(1, 2, 3)

        // Invalid peerId length
        assertThrows(DataFrameException::class.java) {
            encodeDataFrame(1L, PeerKind.HOST, ByteArray(15), dummyPayload)
        }

        // Truncated header
        assertThrows(DataFrameException::class.java) {
            decodeDataFrame(ByteArray(20))
        }

        // Exceeding MAX_DATA_FRAME_BYTES
        val oversize = ByteArray(Limits.MAX_DATA_FRAME_BYTES + 1)
        assertThrows(DataFrameException::class.java) {
            decodeDataFrame(oversize)
        }
    }

    @Test
    fun rlyControlFramesValidation() {
        // Challenge frame
        val challengeJson = """{"t":"challenge","v":1,"nonce":"abcd1234nonce","time":1790000000}"""
        val challenge = RelayJson.decodeFromString(ControlFrame.serializer(), challengeJson)
        assertThat(challenge).isInstanceOf(ControlFrame.Challenge::class.java)
        assertThat((challenge as ControlFrame.Challenge).nonce).isEqualTo("abcd1234nonce")

        // Auth frame
        val authJson = """{"t":"auth","v":1,"kind":"host","id":"h_abcdefghijklmnopqrstuvwx","sig":"sig_test_123"}"""
        val auth = RelayJson.decodeFromString(ControlFrame.serializer(), authJson)
        assertThat(auth).isInstanceOf(ControlFrame.Auth::class.java)
        assertThat((auth as ControlFrame.Auth).kind).isEqualTo("host")

        // Ready frame
        val readyJson = """{"t":"ready","v":1,"id":"h_abcdefghijklmnopqrstuvwx","peers":[{"id":"d_12345678901234567890123456","kind":"device","name":"Pixel 8","online":true,"lastSeenAt":1790000000}]}"""
        val ready = RelayJson.decodeFromString(ControlFrame.serializer(), readyJson)
        assertThat(ready).isInstanceOf(ControlFrame.Ready::class.java)
        val readyFrame = ready as ControlFrame.Ready
        assertThat(readyFrame.peers).hasSize(1)
        assertThat(readyFrame.peers[0].name).isEqualTo("Pixel 8")
        assertThat(readyFrame.peers[0].online).isTrue()

        // Push response
        val pushResJson = """{"t":"push.result","rid":"req_123","results":[{"id":"d_1","status":"sent"}]}"""
        val pushRes = RelayJson.decodeFromString(ControlFrame.serializer(), pushResJson)
        assertThat(pushRes).isInstanceOf(ControlFrame.PushResponse::class.java)
        assertThat((pushRes as ControlFrame.PushResponse).results[0].status).isEqualTo("sent")
    }

    @Test
    fun rcpEnvelopeValidation() {
        // Request
        val req = RcpMessage.Request(id = 1L, m = "ping", p = buildJsonObject { put("t", 1_700_000_000_000L) })
        val reqStr = encodeRcpMessage(req)
        val decodedReq = decodeRcpMessage(reqStr) as RcpMessage.Request
        assertThat(decodedReq.id).isEqualTo(1L)
        assertThat(decodedReq.m).isEqualTo("ping")

        // Response success
        val resSuccess = RcpMessage.Response(id = 1L, ok = true, r = buildJsonObject { put("t", 1) })
        val resStr = encodeRcpMessage(resSuccess)
        val decodedRes = decodeRcpMessage(resStr) as RcpMessage.Response
        assertThat(decodedRes.ok).isTrue()
        assertThat(decodedRes.r?.get("t")?.jsonPrimitive?.content).isEqualTo("1")

        // Response error
        val error = RcpError(code = RcpErrorCodes.RATE_LIMITED, message = "slow down", retryAfterMs = 500)
        val resError = RcpMessage.Response(id = 2L, ok = false, e = error)
        val errStr = encodeRcpMessage(resError)
        val decodedErr = decodeRcpMessage(errStr) as RcpMessage.Response
        assertThat(decodedErr.ok).isFalse()
        assertThat(decodedErr.e?.code).isEqualTo("rate_limited")
        assertThat(decodedErr.e?.retryAfterMs).isEqualTo(500L)

        // Stream item
        val item = RcpMessage.StreamItem(sid = 9L, n = 0L, d = buildJsonObject { put("type", "baseline") })
        val itemStr = encodeRcpMessage(item)
        val decodedItem = decodeRcpMessage(itemStr) as RcpMessage.StreamItem
        assertThat(decodedItem.sid).isEqualTo(9L)
        assertThat(decodedItem.n).isEqualTo(0L)

        // Stream end
        val end = RcpMessage.StreamEnd(sid = 9L, ok = true)
        val endStr = encodeRcpMessage(end)
        val decodedEnd = decodeRcpMessage(endStr) as RcpMessage.StreamEnd
        assertThat(decodedEnd.ok).isTrue()

        // Stream cancel
        val cancel = RcpMessage.StreamCancel(sid = 9L)
        val cancelStr = encodeRcpMessage(cancel)
        val decodedCancel = decodeRcpMessage(cancelStr) as RcpMessage.StreamCancel
        assertThat(decodedCancel.sid).isEqualTo(9L)

        // Event
        val evt = RcpMessage.Event(e = "pair.rejected", d = buildJsonObject { put("reason", "timeout") })
        val evtStr = encodeRcpMessage(evt)
        val decodedEvt = decodeRcpMessage(evtStr) as RcpMessage.Event
        assertThat(decodedEvt.e).isEqualTo("pair.rejected")
    }

    @Test
    fun rcpEnvelopeFailsClosedOnInvalid() {
        // Exceeding MAX_RCP_MESSAGE_BYTES
        val hugeMessage = """{"k":"req","id":1,"m":"${"x".repeat(50_000)}"}"""
        assertThrows(RcpException::class.java) {
            decodeRcpMessage(hugeMessage)
        }

        // Invalid JSON or schema
        assertThrows(RcpException::class.java) {
            decodeRcpMessage("""{"k":"unknown"}""")
        }

        // Failed response missing error
        assertThrows(Exception::class.java) {
            RcpMessage.Response(id = 1L, ok = false, e = null)
        }

        // Successful response containing error
        assertThrows(Exception::class.java) {
            RcpMessage.Response(id = 1L, ok = true, e = RcpError("err", "msg"))
        }
    }

    @Test
    fun sessionEventsDecodingAndFallbacks() {
        // Tool Call
        val toolCallJson = """{"kind":"tool.call","seq":4,"at":1700000000000,"callId":"c1","tool":"shell","title":"List files","args":{"text":"ls","bytes":2,"truncated":false}}"""
        val event = RcpJson.decodeFromString(SessionEvent.serializer(), toolCallJson)
        assertThat(event).isInstanceOf(SessionEvent.ToolCall::class.java)
        val toolCall = event as SessionEvent.ToolCall
        assertThat(toolCall.callId).isEqualTo("c1")
        assertThat(toolCall.args.text).isEqualTo("ls")

        // Unknown kind fallback
        val futureJson = """{"kind":"totally.future.kind","seq":9,"at":10,"payload":{"anything":1}}"""
        val futureEvent = RcpJson.decodeFromString(SessionEvent.serializer(), futureJson)
        assertThat(futureEvent).isInstanceOf(SessionEvent.Unknown::class.java)
        val unknown = futureEvent as SessionEvent.Unknown
        assertThat(unknown.dshType).isEqualTo("totally.future.kind")
        assertThat(unknown.seq).isEqualTo(9L)

        // Open enum fallbacks
        val turnEndJson = """{"kind":"turn.end","seq":1,"at":1,"status":"something-new"}"""
        val turnEnd = RcpJson.decodeFromString(SessionEvent.serializer(), turnEndJson) as SessionEvent.TurnEnd
        assertThat(turnEnd.status).isEqualTo(TurnEndStatus.UNKNOWN)

        val toolResultJson = """{"kind":"tool.result","seq":2,"at":1,"callId":"c1","status":"weird","output":{"text":"","bytes":0,"truncated":false}}"""
        val toolResult = RcpJson.decodeFromString(SessionEvent.serializer(), toolResultJson) as SessionEvent.ToolResult
        assertThat(toolResult.status).isEqualTo(ToolResultStatus.UNKNOWN)

        val sessionStatusJson = """{"kind":"session.status","seq":3,"at":1,"sessionId":"s1","status":"zzz"}"""
        val sessionStatus = RcpJson.decodeFromString(SessionEvent.serializer(), sessionStatusJson) as SessionEvent.SessionStatusEvent
        assertThat(sessionStatus.status).isEqualTo(SessionStatus.UNKNOWN)

        val approvalAskedJson = """{"kind":"approval.asked","seq":5,"at":1,"id":"2b5f6a8e-5c1d-4a2b-9c3e-8f1a2b3c4d5e","toolName":"shell","risk":"extreme"}"""
        val approvalAsked = RcpJson.decodeFromString(SessionEvent.serializer(), approvalAskedJson) as SessionEvent.ApprovalAsked
        assertThat(approvalAsked.risk).isEqualTo(ApprovalRisk.HIGH) // Conservative fallback
    }
}
