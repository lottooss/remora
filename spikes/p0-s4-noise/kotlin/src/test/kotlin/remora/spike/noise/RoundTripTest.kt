package remora.spike.noise

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * End-to-end scenarios with random keys and a Remora-shaped prologue:
 * payload edge cases, tamper/replay behavior, mismatch failures, size limits.
 */
class RoundTripTest {
    @Test
    fun completesWithRandomKeysMatchingHashesAndMutualStaticAuthentication() {
        val pair = newHandshakePair()
        val msg1Payload = utf8("""{"v":1,"purpose":"session","app":{"version":"p0-s4"}}""")
        val msg2Payload = utf8("""{"v":1,"time":0}""")
        val completed = completeHandshake(pair, msg1Payload, msg2Payload)
        assertArrayEquals(msg1Payload, completed.plain1)
        assertArrayEquals(msg2Payload, completed.plain2)
        assertTrue(pair.initiator.isComplete)
        assertTrue(pair.responder.isComplete)
        assertArrayEquals(pair.initiator.result.handshakeHash, pair.responder.result.handshakeHash)
        assertArrayEquals(pair.responder.result.remoteStatic, pair.initKeypair.publicKey)
        assertArrayEquals(pair.initiator.result.remoteStatic, pair.respKeypair.publicKey)
        // msg1 = e(32) + encrypted s(48) + encrypted payload(16 + n); msg2 = e(32) + payload(16 + n).
        val json1 = """{"v":1,"purpose":"session","app":{"version":"p0-s4"}}"""
        val json2 = """{"v":1,"time":0}"""
        assertEquals(80 + 16 + json1.length, completed.msg1.size)
        assertEquals(48 + json2.length, completed.msg2.size)
    }

    @Test
    fun handlesZeroLengthHandshakePayloads() {
        val pair = newHandshakePair()
        val completed = completeHandshake(pair, EMPTY, EMPTY)
        assertEquals(96, completed.msg1.size)
        assertEquals(48, completed.msg2.size)
        assertArrayEquals(pair.initiator.result.handshakeHash, pair.responder.result.handshakeHash)
    }

    @Test
    fun failsWhenThePsksDiffer() {
        val prologue = remoraPrologue("pair")
        val init = generateKeypair()
        val resp = generateKeypair()
        val initiator = HandshakeState(
            initiator = true,
            prologue = prologue,
            staticKeypair = init,
            remoteStatic = resp.publicKey,
            psk = TEST_PSK,
        )
        val responder = HandshakeState(
            initiator = false,
            prologue = prologue,
            staticKeypair = resp,
            psk = ByteArray(32) { 0xaa },
        )
        val msg1 = initiator.writeMessage(utf8("hello"))
        responder.readMessage(msg1)
        val msg2 = responder.writeMessage(utf8("world"))
        assertNoiseError("aead_verification_failed") { initiator.readMessage(msg2) }
    }

    @Test
    fun failsWhenTheProloguesDiffer() {
        val resp = generateKeypair()
        val initiator = HandshakeState(
            initiator = true,
            prologue = remoraPrologue("pair"),
            staticKeypair = generateKeypair(),
            remoteStatic = resp.publicKey,
            psk = TEST_PSK,
        )
        val responder = HandshakeState(
            initiator = false,
            prologue = remoraPrologue("session"),
            staticKeypair = resp,
            psk = TEST_PSK,
        )
        val msg1 = initiator.writeMessage(utf8("hello"))
        assertNoiseError("aead_verification_failed") { responder.readMessage(msg1) }
    }

    @Test
    fun rejectsLowOrderPinnedResponderKey() {
        val initiator = HandshakeState(
            initiator = true,
            prologue = remoraPrologue("session"),
            staticKeypair = generateKeypair(),
            remoteStatic = ByteArray(32),
            psk = TEST_PSK,
        )
        assertNoiseError("invalid_public_key") { initiator.writeMessage(utf8("hello")) }
    }

    @Test
    fun rejectsOutOfTurnAndPostCompletionCalls() {
        val pair = newHandshakePair()
        assertNoiseError("invalid_message") { pair.responder.writeMessage(EMPTY) }
        val msg1 = pair.initiator.writeMessage(utf8("one"))
        assertNoiseError("invalid_message") { pair.initiator.writeMessage(utf8("two")) }
        pair.responder.readMessage(msg1)
        val msg2 = pair.responder.writeMessage(utf8("three"))
        pair.initiator.readMessage(msg2)
        assertNoiseError("handshake_exhausted") { pair.initiator.writeMessage(utf8("four")) }
        assertNoiseError("handshake_exhausted") { pair.responder.readMessage(msg1) }
    }

    @Test
    fun rejectsTruncatedAndTamperedHandshakeMessages() {
        val pair = newHandshakePair()
        val msg1 = pair.initiator.writeMessage(utf8("payload"))
        assertNoiseError("invalid_message") { pair.responder.readMessage(msg1.copyOfRange(0, 60)) }
        val other = newHandshakePair(PairOptions(respStaticSecret = pair.respKeypair.secretKey))
        val tampered = msg1.copyOf()
        tampered[100] = (tampered[100].toInt() xor 0x01).toByte()
        assertNoiseError("aead_verification_failed") { other.responder.readMessage(tampered) }
    }

    @Test
    fun rejectsHandshakeMessagesOverThe65535ByteCeiling() {
        val pair = newHandshakePair()
        assertNoiseError("message_too_large") { pair.initiator.writeMessage(ByteArray(65440)) }
    }

    @Test
    fun requiresAThirtyTwoBytePskAndAnIkInitiatorStaticPin() {
        val resp = generateKeypair()
        assertNoiseError("invalid_key_length") {
            HandshakeState(
                initiator = true,
                prologue = EMPTY,
                staticKeypair = generateKeypair(),
                remoteStatic = resp.publicKey,
                psk = ByteArray(16),
            )
        }
        assertNoiseError("missing_key") {
            HandshakeState(
                initiator = true,
                prologue = EMPTY,
                staticKeypair = generateKeypair(),
            )
        }
    }

    @Test
    fun zeroizesTheStaticAndEphemeralSecretsAfterSplit() {
        val staticSecret = ByteArray(32) { 0x5c }
        val ephemeralSecret = ByteArray(32) { 0xe7 }
        val resp = generateKeypair()
        val initiator = HandshakeState(
            initiator = true,
            prologue = remoraPrologue("session"),
            staticKeypair = keypairFromSecret(staticSecret),
            remoteStatic = resp.publicKey,
            psk = TEST_PSK,
            ephemeralSecret = ephemeralSecret,
        )
        val responder = HandshakeState(
            initiator = false,
            prologue = remoraPrologue("session"),
            staticKeypair = resp,
            psk = TEST_PSK,
        )
        val msg1 = initiator.writeMessage(utf8("x"))
        responder.readMessage(msg1)
        val msg2 = responder.writeMessage(utf8("y"))
        initiator.readMessage(msg2)
        assertTrue(staticSecret.all { it == 0.toByte() })
        assertTrue(ephemeralSecret.all { it == 0.toByte() })
        // Public halves survive.
        assertArrayEquals(initiator.result.handshakeHash, responder.result.handshakeHash)
    }

    @Test
    fun exchanges1000MessagesInEachDirectionWithExactPayloads() {
        val pair = newHandshakePair()
        completeHandshake(pair, utf8(Interop.MSG1), utf8(Interop.MSG2))
        val iSend = pair.initiator.result.send
        val iRecv = pair.initiator.result.recv
        val rSend = pair.responder.result.send
        val rRecv = pair.responder.result.recv
        repeat(Interop.ITERATIONS) { i ->
            val up = utf8(Interop.k2t(i))
            val down = utf8(Interop.t2k(i))
            val upCt = iSend.encryptWithAd(EMPTY, up)
            assertArrayEquals(up, rRecv.decryptWithAd(EMPTY, upCt))
            val downCt = rSend.encryptWithAd(EMPTY, down)
            assertArrayEquals(down, iRecv.decryptWithAd(EMPTY, downCt))
        }
        assertEquals(Interop.ITERATIONS.toULong(), iSend.nonce)
        assertEquals(Interop.ITERATIONS.toULong(), rSend.nonce)
    }

    @Test
    fun encryptsAndDecryptsEmptyTransportPayloads() {
        val pair = newHandshakePair()
        completeHandshake(pair, EMPTY, EMPTY)
        val ciphertext = pair.initiator.result.send.encryptWithAd(EMPTY, EMPTY)
        assertEquals(16, ciphertext.size)
        assertArrayEquals(EMPTY, pair.responder.result.recv.decryptWithAd(EMPTY, ciphertext))
    }

    @Test
    fun supportsAPayloadUpTo65519Bytes() {
        val pair = newHandshakePair()
        completeHandshake(pair, EMPTY, EMPTY)
        val big = ByteArray(MAX_TRANSPORT_PAYLOAD) { 0x7a }
        val ciphertext = pair.initiator.result.send.encryptWithAd(EMPTY, big)
        assertEquals(65535, ciphertext.size)
        assertArrayEquals(big, pair.responder.result.recv.decryptWithAd(EMPTY, ciphertext))
    }

    @Test
    fun failsOnOneFlippedByteAndDoesNotConsumeTheNonce() {
        val pair = newHandshakePair()
        completeHandshake(pair, EMPTY, EMPTY)
        val send = pair.initiator.result.send
        val recv = pair.responder.result.recv
        val ciphertext = send.encryptWithAd(EMPTY, utf8("frame-0"))
        val tampered = ciphertext.copyOf()
        tampered[3] = (tampered[3].toInt() xor 0x01).toByte()
        assertNoiseError("aead_verification_failed") { recv.decryptWithAd(EMPTY, tampered) }
        assertArrayEquals(utf8("frame-0"), recv.decryptWithAd(EMPTY, ciphertext))
    }

    @Test
    fun exposesThePinnedProtocolName() {
        assertEquals("Noise_IKpsk2_25519_ChaChaPoly_SHA256", HandshakeState.PROTOCOL_NAME)
    }
}
