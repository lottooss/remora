package io.github.lottooss.remora.notification

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.crypto.openPushPayload
import io.github.lottooss.remora.core.crypto.PushContext
import io.github.lottooss.remora.core.crypto.sealPushPayload
import org.junit.Test

class PushNotificationTest {

    @Test
    fun testPushPayloadEncryptionDecryption() {
        val key = ByteArray(32) { (it + 1).toByte() }
        val context = PushContext(
            hostId = "h_erruijsx3ey2rmxcpeh3pgxjkm",
            deviceId = "d_erruijsx3ey2rmxcpeh3pgxjkm",
        )
        val json = """{"v":1,"kind":"approval","title":"Test Approval","body":"Needs your approval"}"""

        val sealed = sealPushPayload(key, json, context)
        assertThat(sealed.size).isGreaterThan(12 + 16)

        val opened = openPushPayload(key, sealed, context)
        assertThat(opened).isEqualTo(json)
    }

    @Test
    fun testParsePushPayloadAndChannelMapping() {
        val approvalJson = """{"v":1,"kind":"approval","title":"Approval","body":"Needs approval","pendingId":"p_123"}"""
        val approval = parsePushPayload(approvalJson)
        assertThat(approval).isNotNull()
        assertThat(approval!!.kind).isEqualTo(PushKind.APPROVAL)
        assertThat(channelForKind(approval.kind)).isEqualTo(RemoraNotificationChannel.APPROVALS)
        assertThat(deepLinkForPayload(approval)).isEqualTo("remora://approvals")

        val questionJson = """{"v":1,"kind":"question","title":"Question","body":"Pick one","sessionId":"s_456"}"""
        val question = parsePushPayload(questionJson)
        assertThat(question).isNotNull()
        assertThat(question!!.kind).isEqualTo(PushKind.QUESTION)
        assertThat(channelForKind(question.kind)).isEqualTo(RemoraNotificationChannel.QUESTIONS)
        assertThat(deepLinkForPayload(question)).isEqualTo("remora://session/s_456")

        val turnDoneJson = """{"v":1,"kind":"turn_done","title":"Turn Done","body":"Turn complete","sessionId":"s_789"}"""
        val turnDone = parsePushPayload(turnDoneJson)
        assertThat(turnDone).isNotNull()
        assertThat(turnDone!!.kind).isEqualTo(PushKind.TURN_DONE)
        assertThat(channelForKind(turnDone.kind)).isEqualTo(RemoraNotificationChannel.TURNS)
        assertThat(deepLinkForPayload(turnDone)).isEqualTo("remora://session/s_789")

        val turnErrorJson = """{"v":1,"kind":"turn_error","title":"Turn Error","body":"Turn failed","sessionId":"s_012"}"""
        val turnError = parsePushPayload(turnErrorJson)
        assertThat(turnError).isNotNull()
        assertThat(turnError!!.kind).isEqualTo(PushKind.TURN_ERROR)
        assertThat(channelForKind(turnError.kind)).isEqualTo(RemoraNotificationChannel.ERRORS)
        assertThat(deepLinkForPayload(turnError)).isEqualTo("remora://session/s_012")
    }

    @Test
    fun testHostOfflineChannelExists() {
        assertThat(RemoraNotificationChannel.HOST_OFFLINE).isEqualTo(RemoraNotificationChannel.HOST_OFFLINE)
    }

    @Test
    fun testDroppingInvalidCiphertext() {
        val key = ByteArray(32) { (it + 1).toByte() }
        val corruptData = ByteArray(30) { 0xFF.toByte() }
        val context = PushContext(
            hostId = "h_erruijsx3ey2rmxcpeh3pgxjkm",
            deviceId = "d_erruijsx3ey2rmxcpeh3pgxjkm",
        )

        try {
            openPushPayload(key, corruptData, context)
            assertThat(false).isTrue()
        } catch (_: Exception) {
        }
    }

    @Test
    fun testDroppingInvalidJson() {
        val result = parsePushPayload("not valid json")
        assertThat(result).isNull()
    }

    @Test
    fun testDroppingUnknownKind() {
        val result = parsePushPayload("""{"v":1,"kind":"unknown","title":"Test","body":"Test"}""")
        assertThat(result).isNull()
    }
}
