package remora.spike.noise

import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class CacophonyTest {

    @Test
    fun testCacophonyVector() {
        val conformanceDir = System.getProperty("remora.conformance.dir")
            ?: File("../../../conformance").canonicalPath
        val vectorFile = File(conformanceDir, "vectors/crypto/noise-cacophony-ikpsk2.json")
        assertTrue("Vector file must exist at ${vectorFile.absolutePath}", vectorFile.exists())

        val json = Json.parseToJsonElement(vectorFile.readText()).jsonObject
        val cases = json["cases"]!!.jsonArray

        for (c in cases) {
            val caseObj = c.jsonObject
            val input = caseObj["input"]!!.jsonObject
            val expectObj = caseObj["expect"]!!.jsonObject

            val initPrologue = hexToBytes(input["initPrologue"]!!.jsonPrimitive.content)
            val respPrologue = hexToBytes(input["respPrologue"]!!.jsonPrimitive.content)
            val initPsks = input["initPsks"]!!.jsonArray.map { hexToBytes(it.jsonPrimitive.content) }
            val respPsks = input["respPsks"]!!.jsonArray.map { hexToBytes(it.jsonPrimitive.content) }
            val initStatic = keypairFromSecret(hexToBytes(input["initStatic"]!!.jsonPrimitive.content))
            val initEphemeral = hexToBytes(input["initEphemeral"]!!.jsonPrimitive.content)
            val initRemoteStatic = hexToBytes(input["initRemoteStatic"]!!.jsonPrimitive.content)
            val respStatic = keypairFromSecret(hexToBytes(input["respStatic"]!!.jsonPrimitive.content))
            val respEphemeral = hexToBytes(input["respEphemeral"]!!.jsonPrimitive.content)
            val expectedHandshakeHash = expectObj["handshakeHash"]!!.jsonPrimitive.content

            val initiator = HandshakeState(
                HandshakeOptions(
                    initiator = true,
                    prologue = initPrologue,
                    staticKeypair = initStatic,
                    remoteStatic = initRemoteStatic,
                    psk = initPsks[0],
                    ephemeralSecret = initEphemeral
                )
            )

            val responder = HandshakeState(
                HandshakeOptions(
                    initiator = false,
                    prologue = respPrologue,
                    staticKeypair = respStatic,
                    psk = respPsks[0],
                    ephemeralSecret = respEphemeral
                )
            )

            val messages = input["messages"]!!.jsonArray

            // Message 1: -> e, es, s, ss
            val m1 = messages[0].jsonObject
            val m1Payload = hexToBytes(m1["payload"]!!.jsonPrimitive.content)
            val m1ExpectedCiphertext = m1["ciphertext"]!!.jsonPrimitive.content

            val m1Ciphertext = initiator.writeMessage(m1Payload)
            assertEquals(m1ExpectedCiphertext, bytesToHex(m1Ciphertext))

            val m1Decrypted = responder.readMessage(m1Ciphertext)
            assertEquals(bytesToHex(m1Payload), bytesToHex(m1Decrypted))

            // Message 2: <- e, ee, se, psk
            val m2 = messages[1].jsonObject
            val m2Payload = hexToBytes(m2["payload"]!!.jsonPrimitive.content)
            val m2ExpectedCiphertext = m2["ciphertext"]!!.jsonPrimitive.content

            val m2Ciphertext = responder.writeMessage(m2Payload)
            assertEquals(m2ExpectedCiphertext, bytesToHex(m2Ciphertext))

            val m2Decrypted = initiator.readMessage(m2Ciphertext)
            assertEquals(bytesToHex(m2Payload), bytesToHex(m2Decrypted))

            assertTrue(initiator.isComplete)
            assertTrue(responder.isComplete)

            assertEquals(expectedHandshakeHash, bytesToHex(initiator.result.handshakeHash))
            assertEquals(expectedHandshakeHash, bytesToHex(responder.result.handshakeHash))

            // Transport messages
            for (i in 2 until messages.size) {
                val msg = messages[i].jsonObject
                val payload = hexToBytes(msg["payload"]!!.jsonPrimitive.content)
                val expectedCt = msg["ciphertext"]!!.jsonPrimitive.content

                if (i % 2 == 0) {
                    val ct = initiator.result.send.encryptWithAd(ByteArray(0), payload)
                    assertEquals(expectedCt, bytesToHex(ct))
                    val pt = responder.result.recv.decryptWithAd(ByteArray(0), ct)
                    assertEquals(bytesToHex(payload), bytesToHex(pt))
                } else {
                    val ct = responder.result.send.encryptWithAd(ByteArray(0), payload)
                    assertEquals(expectedCt, bytesToHex(ct))
                    val pt = initiator.result.recv.decryptWithAd(ByteArray(0), ct)
                    assertEquals(bytesToHex(payload), bytesToHex(pt))
                }
            }
        }
    }
}
