package io.github.lottooss.remora.core.crypto

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import java.io.File

class CryptoConformanceTest {

    private val conformanceDir by lazy {
        val path = System.getProperty("remora.conformance.dir") ?: "../../conformance"
        File(path).canonicalFile
    }

    private fun loadVector(name: String) =
        Json.parseToJsonElement(File(conformanceDir, "vectors/crypto/$name").readText()).jsonObject

    /** Fails the case unless the operation throws: error vectors are fail-closed contracts. */
    private fun expectThrows(operation: () -> Unit) {
        val threw = try {
            operation()
            false
        } catch (_: Exception) {
            true
        }
        assertThat(threw).isTrue()
    }

    @Test
    fun testEndpointIdVectors() {
        val root = loadVector("endpoint-id.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            val prefix = input["prefix"]!!.jsonPrimitive.content
            val relayPub = decodeBase64Url(input["relayPubB64u"]!!.jsonPrimitive.content)

            if (caseObj["error"] != null) {
                expectThrows { deriveEndpointId(prefix, relayPub) }
                continue
            }
            val expectedId = caseObj["expect"]!!.jsonObject["endpointId"]!!.jsonPrimitive.content
            val actual = deriveEndpointId(prefix, relayPub)
            assertThat(actual).isEqualTo(expectedId)
        }
    }

    @Test
    fun testRelayAuthVectors() {
        val root = loadVector("relay-auth.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            val fields = RelayAuthFields(
                relayOrigin = input["relayOrigin"]!!.jsonPrimitive.content,
                kind = input["kind"]!!.jsonPrimitive.content,
                endpointId = input["endpointId"]!!.jsonPrimitive.content,
                nonce = decodeBase64Url(input["nonceB64u"]!!.jsonPrimitive.content),
            )

            // Signing vectors carry the private key and assert the canonical-origin rules.
            val privateKeyB64u = input["privateKeyB64u"]?.jsonPrimitive?.content
            if (privateKeyB64u != null) {
                expectThrows { signRelayChallenge(decodeBase64Url(privateKeyB64u), fields) }
                continue
            }

            val pub = decodeBase64Url(input["publicKeyB64u"]!!.jsonPrimitive.content)
            val sig = decodeBase64Url(input["signatureB64u"]!!.jsonPrimitive.content)
            val expectedValid = caseObj["expect"]!!.jsonObject["valid"]!!.jsonPrimitive.content.toBoolean()

            val actual = verifyRelayChallenge(pub, fields, sig)
            assertThat(actual).isEqualTo(expectedValid)
        }
    }

    @Test
    fun testPairingVectors() {
        val root = loadVector("pairing.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            if (input["pairingSecretB64u"] != null) {
                val secret = decodeBase64Url(input["pairingSecretB64u"]!!.jsonPrimitive.content)
                val hostId = input["hostId"]!!.jsonPrimitive.content

                if (caseObj["error"] != null) {
                    expectThrows { derivePairPsk(secret, hostId) }
                    continue
                }
                val expectedHex = caseObj["expect"]!!.jsonObject["pairPskHex"]!!.jsonPrimitive.content
                val actual = derivePairPsk(secret, hostId)
                assertThat(encodeHex(actual)).isEqualTo(expectedHex)
            } else {
                val handshakeHash = decodeHex(input["handshakeHashHex"]!!.jsonPrimitive.content)
                if (caseObj["error"] != null) {
                    expectThrows { deriveSasCode(handshakeHash) }
                    continue
                }
                val expectedSas = caseObj["expect"]!!.jsonObject["sasCode"]!!.jsonPrimitive.content
                assertThat(deriveSasCode(handshakeHash)).isEqualTo(expectedSas)
            }
        }
    }

    @Test
    fun testSasCodeAndQr() {
        // SAS from the handshake transcript hash (Crypto/1 §5.3), matching the
        // pairing.json vector's handshakeHashHex of bytes 0x01..0x20.
        val handshakeHash = ByteArray(32) { (it + 1).toByte() }
        assertThat(deriveSasCode(handshakeHash)).isEqualTo("764025")

        val hostPub = ByteArray(32) { (it + 1).toByte() }
        val pairingSecret = ByteArray(32) { (0xa0 + it).toByte() }
        val pairingData = PairingData(
            relayOrigin = "https://relay.example.test",
            hostId = "h_erruijsx3ey2rmxcpeh3pgxjkm",
            hostNoisePub = hostPub,
            ticket = ByteArray(32) { (0xf0 + (it % 16)).toByte() },
            pairingSecret = pairingSecret,
            hostName = "DESKTOP-OLSI",
            expiry = 2_000_000_000L,
        )
        val qr = buildPairingQr(pairingData)
        assertThat(qr.startsWith("remora://pair?v=1&")).isTrue()
        val parsed = parsePairingQr(qr)
        assertThat(parsed.relayOrigin).isEqualTo(pairingData.relayOrigin)
        assertThat(parsed.hostId).isEqualTo(pairingData.hostId)
        assertThat(encodeHex(parsed.hostNoisePub)).isEqualTo(encodeHex(pairingData.hostNoisePub))
        assertThat(encodeHex(parsed.ticket)).isEqualTo(encodeHex(pairingData.ticket))
        assertThat(encodeHex(parsed.pairingSecret)).isEqualTo(encodeHex(pairingData.pairingSecret))
        assertThat(parsed.hostName).isEqualTo(pairingData.hostName)
        assertThat(parsed.expiry).isEqualTo(pairingData.expiry)
    }

    @Test
    fun testPushPayloadRoundtrip() {
        val key = ByteArray(32) { (it * 3).toByte() }
        val context = PushContext(
            hostId = "h_erruijsx3ey2rmxcpeh3pgxjkm",
            deviceId = "d_erruijsx3ey2rmxcpeh3pgxjkm",
        )
        val json = """{"v":1,"kind":"approval","title":"Test"}"""
        val sealed = sealPushPayload(key, json, context)
        assertThat(sealed.size).isGreaterThan(12 + 16)
        val opened = openPushPayload(key, sealed, context)
        assertThat(opened).isEqualTo(json)
    }

    @Test
    fun testPushVectors() {
        val root = loadVector("push.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            val key = decodeBase64Url(input["pushKeyB64u"]!!.jsonPrimitive.content)
            val context = PushContext(
                hostId = input["hostId"]!!.jsonPrimitive.content,
                deviceId = input["deviceId"]!!.jsonPrimitive.content,
            )
            val sealed = decodeBase64Url(input["sealedB64u"]!!.jsonPrimitive.content)

            if (caseObj["error"] != null) {
                expectThrows { openPushPayload(key, sealed, context) }
                continue
            }
            val expectedValid = caseObj["expect"]!!.jsonObject["valid"]?.jsonPrimitive?.content?.toBoolean()
            val expectedPlaintext = caseObj["expect"]!!.jsonObject["plaintextJson"]?.jsonPrimitive?.content

            if (expectedValid == false) {
                val threw = try {
                    openPushPayload(key, sealed, context); false
                } catch (_: Exception) { true }
                assertThat(threw).isTrue()
            } else {
                assertThat(openPushPayload(key, sealed, context)).isEqualTo(expectedPlaintext)
            }
        }
    }

    @Test
    fun testApprovalVectors() {
        val root = loadVector("approval.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            if (input["text"] != null) {
                val expectedDigest = caseObj["expect"]!!.jsonObject["argsDigestHex"]!!.jsonPrimitive.content
                assertThat(computeArgsDigest(input["text"]!!.jsonPrimitive.content, input["json"]!!.jsonPrimitive.content))
                    .isEqualTo(expectedDigest)
                continue
            }
            val fields = ApprovalMessageFields(
                hostId = input["hostId"]!!.jsonPrimitive.content,
                deviceId = input["deviceId"]!!.jsonPrimitive.content,
                approvalId = input["approvalId"]!!.jsonPrimitive.content,
                sessionId = input["sessionId"]!!.jsonPrimitive.content,
                callId = input["callId"]?.jsonPrimitive?.content,
                toolName = input["toolName"]!!.jsonPrimitive.content,
                argsDigest = input["argsDigest"]!!.jsonPrimitive.content,
                outcome = input["outcome"]!!.jsonPrimitive.content,
                issuedAt = input["issuedAt"]!!.jsonPrimitive.content.toLong(),
            )

            if (caseObj["error"] != null) {
                expectThrows { buildCanonicalApprovalMessage(fields) }
                continue
            }
            val expectedMsg = caseObj["expect"]!!.jsonObject["canonicalMessage"]!!.jsonPrimitive.content

            val actual = buildCanonicalApprovalMessage(fields)
            assertThat(actual).isEqualTo(expectedMsg)
        }
    }

    @Test
    fun testNoiseCacophonyVectors() {
        val root = loadVector("noise-cacophony-ikpsk2.json")
        for (elem in root["cases"]!!.jsonArray) {
            val caseObj = elem.jsonObject
            val input = caseObj["input"]!!.jsonObject
            val expect = caseObj["expect"]!!.jsonObject

            val prologue = decodeHex(input["initPrologue"]!!.jsonPrimitive.content)
            val psk = decodeHex(input["initPsks"]!!.jsonArray[0].jsonPrimitive.content)
            val initStatic = keypairFromSecret(decodeHex(input["initStatic"]!!.jsonPrimitive.content))
            val initEphemeral = decodeHex(input["initEphemeral"]!!.jsonPrimitive.content)
            val respStatic = keypairFromSecret(decodeHex(input["respStatic"]!!.jsonPrimitive.content))
            val respEphemeral = decodeHex(input["respEphemeral"]!!.jsonPrimitive.content)

            val initiator = HandshakeState(
                initiator = true,
                prologue = prologue,
                staticKeypair = initStatic,
                remoteStatic = respStatic.publicKey,
                psk = psk,
                ephemeralSecret = initEphemeral,
            )

            val responder = HandshakeState(
                initiator = false,
                prologue = prologue,
                staticKeypair = respStatic,
                remoteStatic = null,
                psk = psk,
                ephemeralSecret = respEphemeral,
            )

            val messages = input["messages"]!!.jsonArray
            // msg 0: init -> resp
            val msg0In = decodeHex(messages[0].jsonObject["payload"]!!.jsonPrimitive.content)
            val msg0ExpectedCipher = decodeHex(messages[0].jsonObject["ciphertext"]!!.jsonPrimitive.content)
            val msg0Cipher = initiator.writeMessage(msg0In)
            assertThat(encodeHex(msg0Cipher)).isEqualTo(encodeHex(msg0ExpectedCipher))
            val msg0Plain = responder.readMessage(msg0Cipher)
            assertThat(encodeHex(msg0Plain)).isEqualTo(encodeHex(msg0In))

            // msg 1: resp -> init
            val msg1In = decodeHex(messages[1].jsonObject["payload"]!!.jsonPrimitive.content)
            val msg1ExpectedCipher = decodeHex(messages[1].jsonObject["ciphertext"]!!.jsonPrimitive.content)
            val msg1Cipher = responder.writeMessage(msg1In)
            assertThat(encodeHex(msg1Cipher)).isEqualTo(encodeHex(msg1ExpectedCipher))
            val msg1Plain = initiator.readMessage(msg1Cipher)
            assertThat(encodeHex(msg1Plain)).isEqualTo(encodeHex(msg1In))

            assertThat(initiator.isComplete).isTrue()
            assertThat(responder.isComplete).isTrue()

            val expectedHash = expect["handshakeHash"]!!.jsonPrimitive.content
            assertThat(encodeHex(initiator.handshakeHash)).isEqualTo(expectedHash)
            assertThat(encodeHex(responder.handshakeHash)).isEqualTo(expectedHash)

            val initRes = initiator.result
            val respRes = responder.result

            // msg 2: init -> resp transport
            val msg2In = decodeHex(messages[2].jsonObject["payload"]!!.jsonPrimitive.content)
            val msg2ExpectedCipher = decodeHex(messages[2].jsonObject["ciphertext"]!!.jsonPrimitive.content)
            val msg2Cipher = initRes.send.encryptWithAd(EMPTY, msg2In)
            assertThat(encodeHex(msg2Cipher)).isEqualTo(encodeHex(msg2ExpectedCipher))
            val msg2Plain = respRes.recv.decryptWithAd(EMPTY, msg2Cipher)
            assertThat(encodeHex(msg2Plain)).isEqualTo(encodeHex(msg2In))

            // msg 3: resp -> init transport
            val msg3In = decodeHex(messages[3].jsonObject["payload"]!!.jsonPrimitive.content)
            val msg3ExpectedCipher = decodeHex(messages[3].jsonObject["ciphertext"]!!.jsonPrimitive.content)
            val msg3Cipher = respRes.send.encryptWithAd(EMPTY, msg3In)
            assertThat(encodeHex(msg3Cipher)).isEqualTo(encodeHex(msg3ExpectedCipher))
            val msg3Plain = initRes.recv.decryptWithAd(EMPTY, msg3Cipher)
            assertThat(encodeHex(msg3Plain)).isEqualTo(encodeHex(msg3In))
        }
    }
}
