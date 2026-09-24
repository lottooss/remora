package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.crypto.CipherState
import io.github.lottooss.remora.core.crypto.EMPTY
import io.github.lottooss.remora.core.crypto.HandshakeResult
import io.github.lottooss.remora.core.crypto.HandshakeState
import io.github.lottooss.remora.core.crypto.Keypair
import io.github.lottooss.remora.core.crypto.decodeBase32
import io.github.lottooss.remora.core.crypto.deriveSasCode
import io.github.lottooss.remora.core.protocol.DataFrame
import io.github.lottooss.remora.core.protocol.PeerKind
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

const val RECORD_TYPE_HANDSHAKE_MSG1: Byte = 0x01
const val RECORD_TYPE_HANDSHAKE_MSG2: Byte = 0x02
const val RECORD_TYPE_TRANSPORT: Byte = 0x03

class SecureChannelException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/**
 * Initiator-side secure channel (Noise_IKpsk2_25519_ChaChaPoly_SHA256) per Crypto/1 §6.
 */
class SecureChannel(
    val channelId: Long = (SecureRandom().nextInt(0x7fffffff) + 1).toLong(),
    val hostId: String,
    val deviceId: String,
    val hostNoisePub: ByteArray,
    val deviceNoiseKeypair: Keypair,
    private val relayClient: RelayClient,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + Job()),
) {

    private val hostRawId = decodeBase32(hostId.removePrefix("h_"))

    private var sendCipher: CipherState? = null
    private var recvCipher: CipherState? = null
    private var handshakeResult: HandshakeResult? = null

    private val _incomingMessages = MutableSharedFlow<String>(extraBufferCapacity = 64)
    val incomingMessages: SharedFlow<String> = _incomingMessages.asSharedFlow()

    private val msg2Deferred = CompletableDeferred<ByteArray>()
    private val isClosed = AtomicBoolean(false)
    private var frameListenerJob: Job? = null

    init {
        frameListenerJob = scope.launch {
            relayClient.incomingDataFrames.collect { frame ->
                if (frame.channel == channelId) {
                    handleIncomingFrame(frame)
                }
            }
        }
    }

    suspend fun handshake(
        purpose: String,
        psk: ByteArray,
        msg1PayloadJson: String,
        timeoutMs: Long = 10_000,
    ): Pair<HandshakeResult, String?> {
        val prologue = "remora/1\u0000$purpose\u0000$hostId\u0000$deviceId".toByteArray(Charsets.UTF_8)

        val handshake = HandshakeState(
            initiator = true,
            prologue = prologue,
            staticKeypair = deviceNoiseKeypair,
            remoteStatic = hostNoisePub,
            psk = psk,
        )

        // Write msg1
        val msg1Bytes = handshake.writeMessage(msg1PayloadJson.toByteArray(Charsets.UTF_8))
        val msg1Record = byteArrayOf(RECORD_TYPE_HANDSHAKE_MSG1) + msg1Bytes

        relayClient.sendData(channelId, PeerKind.HOST, hostRawId, msg1Record)

        // Wait for msg2
        val msg2Record = withTimeout(timeoutMs) {
            msg2Deferred.await()
        }

        val msg2Bytes = msg2Record.sliceArray(1 until msg2Record.size)
        handshake.readMessage(msg2Bytes)

        val result = handshake.result
            ?: throw SecureChannelException("Handshake did not produce cipher states")

        handshakeResult = result
        sendCipher = result.send
        recvCipher = result.recv

        val sasCode = if (purpose == "pair") {
            deriveSasCode(hostNoisePub, deviceNoiseKeypair.publicKey, psk)
        } else {
            null
        }

        return result to sasCode
    }

    suspend fun sendTransport(payloadUtf8: String) {
        val cipher = sendCipher ?: throw SecureChannelException("Secure channel not established")
        if (isClosed.get()) throw SecureChannelException("Secure channel is closed")

        val plaintext = payloadUtf8.toByteArray(Charsets.UTF_8)
        val ciphertext = cipher.encryptWithAd(EMPTY, plaintext)
        val record = byteArrayOf(RECORD_TYPE_TRANSPORT) + ciphertext

        relayClient.sendData(channelId, PeerKind.HOST, hostRawId, record)
    }

    fun close() {
        if (isClosed.compareAndSet(false, true)) {
            frameListenerJob?.cancel()
            sendCipher?.zeroize()
            recvCipher?.zeroize()
            sendCipher = null
            recvCipher = null
        }
    }

    private fun handleIncomingFrame(frame: DataFrame) {
        if (frame.payload.isEmpty()) return
        val recordType = frame.payload[0]

        when (recordType) {
            RECORD_TYPE_HANDSHAKE_MSG2 -> {
                msg2Deferred.complete(frame.payload)
            }

            RECORD_TYPE_TRANSPORT -> {
                val cipher = recvCipher ?: return
                try {
                    val ciphertext = frame.payload.sliceArray(1 until frame.payload.size)
                    val plaintext = cipher.decryptWithAd(EMPTY, ciphertext)
                    val messageUtf8 = plaintext.toString(Charsets.UTF_8)
                    _incomingMessages.tryEmit(messageUtf8)
                } catch (e: Exception) {
                    // Decryption failed or channel corrupted
                    close()
                }
            }
        }
    }
}
