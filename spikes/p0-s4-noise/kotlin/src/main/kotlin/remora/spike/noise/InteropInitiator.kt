package remora.spike.noise

import kotlin.system.exitProcess

/**
 * Cross-language interop initiator (see docs/spikes/P0-S4.md §Interop).
 *
 * Runs as `java -jar p0-s4-noise-interop.jar` spawned by the TS side, which acts as the
 * responder over stdin/stdout: hex lines carry Noise messages, lines starting with `#`
 * are control markers. Constants are mirrored byte-for-byte in ts/test/helpers.ts.
 */
object Interop {
    const val MSG1 = """{"v":1,"purpose":"session","app":{"version":"p0-s4"}}"""
    const val MSG2 = """{"v":1,"time":0}"""

    /** Obviously fake 32-byte PSK for the spike only. */
    val PSK: ByteArray = hexToBytes("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")

    /** Obviously fake static secrets (32×0x10 / 32×0x20). */
    val INIT_STATIC_SECRET: ByteArray = ByteArray(32) { 0x10 }
    val RESP_STATIC_SECRET: ByteArray = ByteArray(32) { 0x20 }

    /** Crypto/1 §6 prologue: "remora/1" ‖ 0x00 ‖ purpose ‖ 0x00 ‖ hostId ‖ 0x00 ‖ deviceId. */
    fun prologue(): ByteArray =
        utf8("remora/1") + byteArrayOf(0) + utf8("session") + byteArrayOf(0) +
            utf8("h_test") + byteArrayOf(0) + utf8("d_test")

    fun k2t(i: Int): String = "K2T:$i"
    fun t2k(i: Int): String = "T2K:$i"
    const val TAMPER_FROM_K = "tamper-k"
    const val TAMPER_FROM_T = "tamper-t"
    const val ITERATIONS = 1000
}

fun main() {
    try {
        runInterop()
    } catch (error: Throwable) {
        System.err.println("interop failed: ${error.message}")
        error.printStackTrace()
        exitProcess(1)
    }
}

private fun runInterop() {
    val output = System.out.bufferedWriter()
    val input = System.`in`.bufferedReader()
    fun send(line: String) {
        output.write(line)
        output.newLine()
        output.flush()
    }

    val initiatorKeypair = keypairFromSecret(Interop.INIT_STATIC_SECRET)
    val responderPublicKey = keypairFromSecret(Interop.RESP_STATIC_SECRET).publicKey
    val handshake = HandshakeState(
        initiator = true,
        prologue = Interop.prologue(),
        staticKeypair = initiatorKeypair,
        remoteStatic = responderPublicKey,
        psk = Interop.PSK,
    )

    send(bytesToHex(handshake.writeMessage(utf8(Interop.MSG1))))
    val msg2Hex = input.readLine() ?: error("EOF waiting for message 2")
    val receivedMsg2 = handshake.readMessage(hexToBytes(msg2Hex))
    if (!receivedMsg2.contentEquals(utf8(Interop.MSG2))) error("message 2 payload mismatch")
    send("#hash ${bytesToHex(handshake.result.handshakeHash)}")

    repeat(Interop.ITERATIONS) { i ->
        val ciphertext = handshake.result.send.encryptWithAd(EMPTY, utf8(Interop.k2t(i)))
        send(bytesToHex(ciphertext))
        val replyHex = input.readLine() ?: error("EOF in transport loop at $i")
        val plaintext = handshake.result.recv.decryptWithAd(EMPTY, hexToBytes(replyHex))
        if (!plaintext.contentEquals(utf8(Interop.t2k(i)))) error("transport payload mismatch at $i")
    }

    // Responder sends a 1-byte-tampered frame: K must reject it without advancing n.
    val tamperedHex = input.readLine() ?: error("EOF waiting for tampered frame")
    try {
        handshake.result.recv.decryptWithAd(EMPTY, hexToBytes(tamperedHex))
        error("tampered frame from responder decrypted successfully")
    } catch (error: NoiseError) {
        if (error.code != "aead_verification_failed") throw error
    }
    send("#tamper-k-ok")

    // K sends a 1-byte-tampered frame; the TS side must reject it and reply #done.
    val ct = handshake.result.send.encryptWithAd(EMPTY, utf8(Interop.TAMPER_FROM_K))
    ct[0] = (ct[0].toInt() xor 1).toByte()
    send(bytesToHex(ct))
    val last = input.readLine() ?: error("EOF waiting for #done")
    if (last != "#done") error("expected #done, got: $last")
}
