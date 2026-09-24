package io.github.lottooss.remora.spike.approvalkey

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalMessageTest {

    private fun sample(
        callId: String? = "call-1",
        outcome: ApprovalOutcome = ApprovalOutcome.ALLOWED_ONCE,
        issuedAt: Long = 1790000000000L,
        argsDigest: String = ASCII_DIGEST,
    ) = ApprovalMessage(
        hostId = "h_spike",
        deviceId = "d_spike",
        approvalId = "appr-000001",
        sessionId = "s-0001",
        callId = callId,
        toolName = "bash",
        argsDigest = argsDigest,
        outcome = outcome,
        issuedAt = issuedAt,
    )

    @Test
    fun canonicalIsTenLinesJoinedByNewlineWithoutTrailingNewline() {
        val expected = listOf(
            "remora/1 approval",
            "h_spike",
            "d_spike",
            "appr-000001",
            "s-0001",
            "call-1",
            "bash",
            ASCII_DIGEST,
            "allowed-once",
            "1790000000000",
        ).joinToString("\n")
        val canonical = sample().canonical()
        assertEquals(expected, canonical)
        assertEquals(10, canonical.split("\n").size)
        assertFalse(canonical.endsWith("\n"))
    }

    @Test
    fun absentCallIdSerializesAsDash() {
        assertTrue(sample(callId = null).canonical().split("\n")[5] == "-")
    }

    @Test
    fun rejectedOutcomeUsesWireVocabulary() {
        assertEquals("rejected", sample(outcome = ApprovalOutcome.REJECTED).canonical().split("\n")[8])
        assertEquals("allowed-once", ApprovalOutcome.ALLOWED_ONCE.wire)
        assertEquals(ApprovalOutcome.REJECTED, ApprovalOutcome.fromWire("rejected"))
    }

    @Test
    fun newlineInFieldIsRejected() {
        val e = assertThrows(IllegalArgumentException::class.java) {
            sample().copy(toolName = "bash\nrm -rf /")
        }
        assertTrue(e.message!!.contains("toolName"))
    }

    @Test
    fun malformedDigestIsRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            sample(argsDigest = "ab".repeat(31))
        }
        assertThrows(IllegalArgumentException::class.java) {
            sample(argsDigest = "AB".repeat(32))
        }
    }

    @Test
    fun negativeIssuedAtIsRejected() {
        assertThrows(IllegalArgumentException::class.java) { sample(issuedAt = -1) }
    }

    @Test
    fun argsDigestMatchesAsciiVector() {
        assertEquals(
            ASCII_DIGEST,
            computeArgsDigest(
                "Run command: git push --force origin main",
                """{"command":"git push --force origin main","cwd":"/home/owner/repo"}""",
            ),
        )
    }

    @Test
    fun argsDigestMatchesUtf8Vector() {
        assertEquals(
            UTF8_DIGEST,
            computeArgsDigest(
                "Mul: \u00b5=\u00a9 \u0434\u0430\u043d\u043d\u044b\u0435",
                """{"note":"\u00b5\u00a9 \u0434\u0430\u043d\u043d\u044b"}""",
            ),
        )
    }

    @Test
    fun argsDigestOfEmptyInputsIsSha256OfSingleZeroByte() {
        assertEquals(
            "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
            computeArgsDigest("", ""),
        )
    }

    private companion object {
        const val ASCII_DIGEST = "2189f6b6d6012ba8c87f8e74d79e9588d0ce29cbf50d8e32956983fad4131a40"
        const val UTF8_DIGEST = "c2794f083c5121b981e0b2ac9768d9f31fcbd366575f0370f1d66ddc91d3ba6e"
    }
}
