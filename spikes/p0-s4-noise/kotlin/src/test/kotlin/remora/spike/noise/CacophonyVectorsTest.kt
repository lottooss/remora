package remora.spike.noise

import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Runs the official Cacophony vector for Noise_IKpsk2_25519_ChaChaPoly_SHA256
 * (conformance/vectors/crypto/noise-cacophony-ikpsk2.json) — the shared TS/Kotlin vector file.
 */
class CacophonyVectorsTest {
    @Test
    fun fileMetadata() {
        assertEquals("crypto/noise-cacophony-ikpsk2", doc["suite"]!!.jsonPrimitive.content)
        assertEquals(1, doc["version"]!!.jsonPrimitive.content.toInt())
        val source = doc["source"]!!.jsonPrimitive.content
        assertTrue(source.contains("cacophony.txt"))
        assertTrue(source.contains("Unlicense"))
        assertTrue(cases.size >= 1)
    }

    @Test
    fun cacophonyIkpsk2Vectors() {
        cases.forEach { runVector(it) }
    }

    @Test
    fun protocolNameLongerThanHashLen() {
        // Sanity: the runner pins the protocol by construction; name > HASHLEN forces the hashed path.
        assertEquals(36, HandshakeState.PROTOCOL_NAME.toByteArray(Charsets.UTF_8).size)
    }

    private fun runVector(testCase: Map<String, kotlinx.serialization.json.JsonElement>) {
        val input = testCase["input"]!!.jsonObject
        val expect = testCase["expect"]!!.jsonObject
        val protocolName = input["protocolName"]!!.jsonPrimitive.content
        assertEquals("Noise_IKpsk2_25519_ChaChaPoly_SHA256", protocolName)
        assertEquals(
            input["initPrologue"]!!.jsonPrimitive.content,
            input["respPrologue"]!!.jsonPrimitive.content,
        )
        val initPsks = input["initPsks"]!!.jsonArray
        val respPsks = input["respPsks"]!!.jsonArray
        assertEquals(1, initPsks.size)
        assertEquals(initPsks[0].jsonPrimitive.content, respPsks[0].jsonPrimitive.content)
        val psk = hexToBytes(initPsks[0].jsonPrimitive.content)
        val prologue = hexToBytes(input["initPrologue"]!!.jsonPrimitive.content)

        val initKeypair = keypairFromSecret(hexToBytes(input["initStatic"]!!.jsonPrimitive.content))
        val respKeypair = keypairFromSecret(hexToBytes(input["respStatic"]!!.jsonPrimitive.content))
        // The initiator pins the responder public key; it must be the responder's.
        assertEquals(
            input["initRemoteStatic"]!!.jsonPrimitive.content,
            bytesToHex(respKeypair.publicKey),
        )

        val initiator = HandshakeState(
            initiator = true,
            prologue = prologue,
            staticKeypair = initKeypair,
            remoteStatic = hexToBytes(input["initRemoteStatic"]!!.jsonPrimitive.content),
            psk = psk,
            ephemeralSecret = hexToBytes(input["initEphemeral"]!!.jsonPrimitive.content),
        )
        val responder = HandshakeState(
            initiator = false,
            prologue = prologue,
            staticKeypair = respKeypair,
            psk = psk,
            ephemeralSecret = hexToBytes(input["respEphemeral"]!!.jsonPrimitive.content),
        )

        val messages = input["messages"]!!.jsonArray
        assertEquals(6, messages.size)
        messages.forEachIndexed { index, element ->
            val message = element.jsonObject
            val payloadHex = message["payload"]!!.jsonPrimitive.content
            val ciphertextHex = message["ciphertext"]!!.jsonPrimitive.content
            val payload = hexToBytes(payloadHex)
            when (index) {
                0 -> {
                    val out = initiator.writeMessage(payload)
                    assertEquals(ciphertextHex, bytesToHex(out))
                    assertEquals(payloadHex, bytesToHex(responder.readMessage(out)))
                }
                1 -> {
                    val out = responder.writeMessage(payload)
                    assertEquals(ciphertextHex, bytesToHex(out))
                    assertEquals(payloadHex, bytesToHex(initiator.readMessage(out)))
                }
                else -> {
                    // Transport phase: even index = initiator → responder (c1), odd = reverse (c2).
                    val send = if (index % 2 == 0) initiator.result.send else responder.result.send
                    val recv = if (index % 2 == 0) responder.result.recv else initiator.result.recv
                    val ciphertext = send.encryptWithAd(EMPTY, payload)
                    assertEquals(ciphertextHex, bytesToHex(ciphertext))
                    assertEquals(payloadHex, bytesToHex(recv.decryptWithAd(EMPTY, ciphertext)))
                }
            }
        }

        assertTrue(initiator.isComplete)
        assertTrue(responder.isComplete)
        val expectedHash = expect["handshakeHash"]!!.jsonPrimitive.content
        assertEquals(expectedHash, bytesToHex(initiator.result.handshakeHash))
        assertEquals(expectedHash, bytesToHex(responder.result.handshakeHash))
        // Responder learned the initiator static key from message 1 (session admission).
        assertTrue(responder.result.remoteStatic.contentEquals(initKeypair.publicKey))
    }

    companion object {
        private val vectorFile: File = run {
            val dir = System.getProperty("remora.conformance.dir")
                ?: error("test property remora.conformance.dir not set")
            val file = File(dir, "vectors/crypto/noise-cacophony-ikpsk2.json")
            check(file.isFile) { "vector file not found: $file" }
            file
        }

        private val doc = Json.parseToJsonElement(vectorFile.readText()).jsonObject

        private val cases: List<Map<String, kotlinx.serialization.json.JsonElement>> =
            doc["cases"]!!.jsonArray.map { it.jsonObject }
    }
}
