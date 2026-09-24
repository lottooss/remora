package remora.spike.noise

import org.junit.Assert

/** Obviously fake 32-byte PSK for spike tests only. */
val TEST_PSK: ByteArray = hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")

/** Crypto/1 §6 prologue: "remora/1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ hostId ‖ 0x00 ‖ deviceId. */
fun remoraPrologue(
    purpose: String,
    hostId: String = "h_test",
    deviceId: String = "d_test",
): ByteArray =
    utf8("remora/1") + byteArrayOf(0) + utf8(purpose) + byteArrayOf(0) +
        utf8(hostId) + byteArrayOf(0) + utf8(deviceId)

data class HandshakePair(
    val initiator: HandshakeState,
    val responder: HandshakeState,
    val initKeypair: Keypair,
    val respKeypair: Keypair,
    val prologue: ByteArray,
    val psk: ByteArray,
)

data class PairOptions(
    val prologue: ByteArray? = null,
    val psk: ByteArray? = null,
    val initStaticSecret: ByteArray? = null,
    val respStaticSecret: ByteArray? = null,
)

/** Fresh random (or fixed) static keys plus both handshake states, pre-handshake. */
fun newHandshakePair(options: PairOptions = PairOptions()): HandshakePair {
    val prologue = options.prologue ?: remoraPrologue("session")
    val psk = options.psk ?: TEST_PSK
    val initKeypair = options.initStaticSecret?.let { keypairFromSecret(it) } ?: generateKeypair()
    val respKeypair = options.respStaticSecret?.let { keypairFromSecret(it) } ?: generateKeypair()
    val initiator = HandshakeState(
        initiator = true,
        prologue = prologue,
        staticKeypair = initKeypair,
        remoteStatic = respKeypair.publicKey,
        psk = psk,
    )
    val responder = HandshakeState(
        initiator = false,
        prologue = prologue,
        staticKeypair = respKeypair,
        psk = psk,
    )
    return HandshakePair(initiator, responder, initKeypair, respKeypair, prologue, psk)
}

data class CompletedHandshake(
    val msg1: ByteArray,
    val msg2: ByteArray,
    val plain1: ByteArray,
    val plain2: ByteArray,
)

/** Run message 1 and message 2 with the given payloads; both states must complete. */
fun completeHandshake(pair: HandshakePair, payload1: ByteArray, payload2: ByteArray): CompletedHandshake {
    val msg1 = pair.initiator.writeMessage(payload1)
    val plain1 = pair.responder.readMessage(msg1)
    val msg2 = pair.responder.writeMessage(payload2)
    val plain2 = pair.initiator.readMessage(msg2)
    return CompletedHandshake(msg1, msg2, plain1, plain2)
}

/** Asserts that [block] throws a NoiseError with the given snake_case code. */
fun assertNoiseError(expectedCode: String, block: () -> Unit) {
    try {
        block()
        Assert.fail("expected NoiseError($expectedCode) but nothing was thrown")
    } catch (error: NoiseError) {
        Assert.assertEquals(expectedCode, error.code)
    }
}
