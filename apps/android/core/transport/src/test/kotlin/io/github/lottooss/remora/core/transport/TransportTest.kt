package io.github.lottooss.remora.core.transport

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.deriveEndpointId
import io.github.lottooss.remora.core.crypto.generateKeypair
import io.github.lottooss.remora.core.crypto.getRelayPublicKey
import io.github.lottooss.remora.core.crypto.verifyRelayChallenge
import io.github.lottooss.remora.core.protocol.PeerKind
import io.github.lottooss.remora.core.protocol.encodeDataFrame
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Test
import java.security.SecureRandom

class FakeWebSocket(private val listener: WebSocketListener) : WebSocket {
    val sentTexts = mutableListOf<String>()
    val sentByteStrings = mutableListOf<ByteString>()
    var isClosed = false

    override fun request(): Request = Request.Builder().url("wss://relay.example.com/v1/connect").build()
    override fun queueSize(): Long = 0L

    override fun send(text: String): Boolean {
        sentTexts.add(text)
        return true
    }

    override fun send(bytes: ByteString): Boolean {
        sentByteStrings.add(bytes)
        return true
    }

    override fun close(code: Int, reason: String?): Boolean {
        isClosed = true
        listener.onClosed(this, code, reason ?: "")
        return true
    }

    override fun cancel() {
        isClosed = true
    }

    fun simulateMessage(text: String) {
        listener.onMessage(this, text)
    }

    fun simulateMessage(bytes: ByteArray) {
        listener.onMessage(this, bytes.toByteString())
    }
}

class FakeWebSocketFactory : WebSocketFactory {
    var lastCreatedSocket: FakeWebSocket? = null

    override fun createWebSocket(request: Request, listener: WebSocketListener): WebSocket {
        val socket = FakeWebSocket(listener)
        lastCreatedSocket = socket
        return socket
    }
}

class TransportTest {

    private val json = Json { ignoreUnknownKeys = true }

    @Test
    fun testRelayClientAuthAndPresenceFlow() = runBlocking {
        val relayPrivKey = ByteArray(32)
        SecureRandom().nextBytes(relayPrivKey)
        val relayPubKey = getRelayPublicKey(relayPrivKey)
        val deviceId = deriveEndpointId("d_", relayPubKey)

        val factory = FakeWebSocketFactory()
        val client = RelayClient(
            relayOrigin = "https://relay.example.com",
            deviceId = deviceId,
            relayPrivateKey = relayPrivKey,
            webSocketFactory = factory,
        )

        client.connect()
        val ws = factory.lastCreatedSocket
        assertThat(ws).isNotNull()
        assertThat(client.connectionState.value).isEqualTo(ConnectionState.Connecting)

        // 1. Simulate challenge
        val nonce = "challenge_nonce_12345"
        ws!!.simulateMessage("""{"t":"challenge","nonce":"$nonce","time":1000}""")

        assertThat(client.connectionState.value).isEqualTo(ConnectionState.Authenticating)
        assertThat(ws.sentTexts).hasSize(1)

        val authSent = json.parseToJsonElement(ws.sentTexts[0]).jsonObject
        assertThat(authSent["t"]?.jsonPrimitive?.content).isEqualTo("auth")
        assertThat(authSent["id"]?.jsonPrimitive?.content).isEqualTo(deviceId)

        val sigB64u = authSent["sig"]?.jsonPrimitive?.content ?: ""
        val sig = decodeBase64Url(sigB64u)
        val sigValid = verifyRelayChallenge(relayPubKey, nonce, sig)
        assertThat(sigValid).isTrue()

        // 2. Simulate ready with initial peers
        ws.simulateMessage("""{"t":"ready","id":"$deviceId","peers":[{"id":"h_test1234567890123456789012","kind":"host","online":true}]}""")
        assertThat(client.connectionState.value).isEqualTo(ConnectionState.Ready)

        // 3. Simulate presence update
        var presenceReceived: RelayPeer? = null
        val presenceJob = launch {
            presenceReceived = client.presenceFlow.filter { !it.online }.first()
        }

        ws.simulateMessage("""{"t":"presence","id":"h_test1234567890123456789012","kind":"host","online":false,"at":1050}""")
        presenceJob.join()

        assertThat(presenceReceived).isNotNull()
        assertThat(presenceReceived!!.id).isEqualTo("h_test1234567890123456789012")
        assertThat(presenceReceived!!.online).isFalse()

        client.disconnect()
        assertThat(client.connectionState.value).isEqualTo(ConnectionState.Idle)
    }

    @Test
    fun testRelayClientDataSendAndReceive() = runBlocking {
        val relayPrivKey = ByteArray(32) { 0x01 }
        val relayPubKey = getRelayPublicKey(relayPrivKey)
        val deviceId = deriveEndpointId("d_", relayPubKey)

        val factory = FakeWebSocketFactory()
        val client = RelayClient(
            relayOrigin = "https://relay.example.com",
            deviceId = deviceId,
            relayPrivateKey = relayPrivKey,
            webSocketFactory = factory,
        )

        client.connect()
        val ws = factory.lastCreatedSocket!!
        ws.simulateMessage("""{"t":"challenge","nonce":"nonce_1","time":1000}""")
        ws.simulateMessage("""{"t":"ready","id":"$deviceId","peers":[]}""")

        val peerId = ByteArray(16) { 0x02 }
        val payload = "hello data frame".toByteArray()
        client.sendData(channel = 100L, peerKind = PeerKind.HOST, peerId = peerId, payload = payload)

        assertThat(ws.sentByteStrings).hasSize(1)
        val sentBytes = ws.sentByteStrings[0].toByteArray()
        assertThat(sentBytes.size).isGreaterThan(28)

        // Simulate incoming data frame
        var receivedFrame: io.github.lottooss.remora.core.protocol.DataFrame? = null
        val frameJob = launch {
            receivedFrame = client.incomingDataFrames.first()
        }

        val inboundBytes = encodeDataFrame(100L, PeerKind.HOST, peerId, payload)
        ws.simulateMessage(inboundBytes)
        frameJob.join()

        assertThat(receivedFrame).isNotNull()
        assertThat(receivedFrame!!.channel).isEqualTo(100L)
        assertThat(receivedFrame!!.payload).isEqualTo(payload)

        client.disconnect()
    }

    @Test
    fun testNoSecretsInLogs() {
        // Log-scan invariant check: keys, PSKs, tokens must not be exposed in error messages or toString
        val relayPrivKey = ByteArray(32) { 0x99.toByte() }
        val info = HostConnectionInfo(
            hostId = "h_test1234567890123456789012",
            hostNoisePub = ByteArray(32) { 0x11 },
            relayOrigin = "https://relay.example.com",
            deviceId = "d_pixel123456789012345678901",
            relayPrivateKey = relayPrivKey,
            noiseKeypair = generateKeypair(),
            devicePsk = ByteArray(32) { 0x22 },
        )

        val str = info.toString()
        assertThat(str).doesNotContain(relayPrivKey.contentToString())
        assertThat(str).doesNotContain("99")
    }
}
