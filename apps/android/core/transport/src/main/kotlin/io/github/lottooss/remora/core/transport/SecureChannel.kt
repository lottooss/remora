package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.crypto.*
import io.github.lottooss.remora.core.protocol.DataFrame
import io.github.lottooss.remora.core.protocol.PeerKind
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean

const val RECORD_TYPE_HANDSHAKE_MSG1: Byte = 0x01
const val RECORD_TYPE_HANDSHAKE_MSG2: Byte = 0x02
const val RECORD_TYPE_TRANSPORT: Byte = 0x03
private const val MAX_RCP_BYTES = 49_152

class SecureChannelException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/** Initiator-side authenticated SC/1 channel. Any record failure closes the channel. */
class SecureChannel(
    val channelId: Long = (SecureRandom().nextInt().toLong() and 0xffffffffL).coerceAtLeast(1),
    val hostId: String,
    val deviceId: String,
    val hostNoisePub: ByteArray,
    val deviceNoiseKeypair: Keypair,
    private val relayClient: RelayClient,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + SupervisorJob()),
) {
    private val hostRawId = decodeBase32(hostId.removePrefix("h_"))
    private var sendCipher: CipherState? = null
    private var recvCipher: CipherState? = null
    private var handshakeState: HandshakeState? = null
    private val incoming = MutableSharedFlow<String>(extraBufferCapacity = 64)
    val incomingMessages: SharedFlow<String> = incoming.asSharedFlow()
    private val handshakeReady = CompletableDeferred<HandshakeResult>()
    private val closedSignal = CompletableDeferred<Unit>()
    val closed: Deferred<Unit> get() = closedSignal
    private val isClosed = AtomicBoolean(false)
    private val sendMutex = Mutex()
    private val cipherLock = Any()
    private var sent = 0L
    private var received = 0L
    private val createdAt = System.nanoTime()
    private val listener = scope.launch(start = CoroutineStart.UNDISPATCHED) {
        relayClient.incomingDataFrames.collect { frame ->
            if (frame.channel == channelId && frame.peerKind == PeerKind.HOST &&
                MessageDigest.isEqual(frame.peerId, hostRawId)) handleFrame(frame)
        }
    }

    suspend fun handshake(purpose: String, psk: ByteArray, msg1PayloadJson: String, timeoutMs: Long = 10_000): Pair<HandshakeResult, String?> {
        check(handshakeState == null && !isClosed.get()) { "Channel handshake already started" }
        require(purpose == "pair" || purpose == "session")
        // HandshakeState zeroizes its static private key when it finishes. It must never own
        // the reusable device key retained for pair.complete persistence or reconnection.
        val handshakeKeys = Keypair(deviceNoiseKeypair.secretKey.copyOf(), deviceNoiseKeypair.publicKey.copyOf())
        val handshakePsk = psk.copyOf()
        try {
            val handshake = HandshakeState(
                initiator = true,
                prologue = "remora/1\u0000$purpose\u0000$hostId\u0000$deviceId".toByteArray(),
                staticKeypair = handshakeKeys, remoteStatic = hostNoisePub, psk = handshakePsk,
            )
            handshakeState = handshake
            val record = byteArrayOf(RECORD_TYPE_HANDSHAKE_MSG1) + handshake.writeMessage(msg1PayloadJson.toByteArray())
            relayClient.sendData(channelId, PeerKind.HOST, hostRawId, record)
            val result = withTimeout(timeoutMs) { handshakeReady.await() }
            return result to if (purpose == "pair") deriveSasCode(hostNoisePub, deviceNoiseKeypair.publicKey, psk) else null
        } catch (error: Exception) { close(); throw error }
        finally {
            synchronized(cipherLock) {
                handshakeKeys.secretKey.fill(0)
                handshakePsk.fill(0)
            }
        }
    }

    suspend fun sendTransport(payloadUtf8: String) = sendMutex.withLock {
        checkUsable(sent)
        val plaintext = payloadUtf8.toByteArray(Charsets.UTF_8)
        require(plaintext.size <= MAX_RCP_BYTES) { "RCP message too large" }
        try {
            val ciphertext = synchronized(cipherLock) {
                val cipher = sendCipher ?: throw SecureChannelException("Channel not established")
                cipher.encryptWithAd(EMPTY, plaintext)
            }
            val record = byteArrayOf(RECORD_TYPE_TRANSPORT) + ciphertext
            relayClient.sendData(channelId, PeerKind.HOST, hostRawId, record)
            sent++
        } catch (error: Exception) { close(); throw error }
        finally { plaintext.fill(0) }
    }

    fun close() {
        if (!isClosed.compareAndSet(false, true)) return
        closedSignal.complete(Unit)
        handshakeReady.completeExceptionally(SecureChannelException("Channel closed"))
        listener.cancel()
        synchronized(cipherLock) {
            sendCipher?.zeroize(); recvCipher?.zeroize()
            sendCipher = null; recvCipher = null; handshakeState = null
        }
    }

    private fun checkUsable(count: Long) {
        if (isClosed.get() || count >= (1L shl 20) || System.nanoTime() - createdAt >= 86_400_000_000_000L) {
            close(); throw SecureChannelException("Channel needs a new handshake")
        }
    }

    private suspend fun handleFrame(frame: DataFrame) {
        if (isClosed.get()) return
        try {
            require(frame.payload.isNotEmpty())
            when (frame.payload[0]) {
                RECORD_TYPE_HANDSHAKE_MSG2 -> {
                    val result = synchronized(cipherLock) {
                        if (isClosed.get()) return
                        check(!handshakeReady.isCompleted)
                        val handshake = handshakeState ?: error("Unexpected handshake")
                        handshake.readMessage(frame.payload.copyOfRange(1, frame.payload.size))
                        // Install ciphers before the next pair.complete can arrive.
                        handshake.result.also { sendCipher = it.send; recvCipher = it.recv }
                    }
                    handshakeReady.complete(result)
                }
                RECORD_TYPE_TRANSPORT -> {
                    checkUsable(received)
                    require(frame.payload.size <= MAX_RCP_BYTES + 17)
                    val plaintext = synchronized(cipherLock) {
                        val cipher = recvCipher ?: error("Unexpected transport record")
                        cipher.decryptWithAd(EMPTY, frame.payload.copyOfRange(1, frame.payload.size))
                    }
                    try {
                        require(plaintext.size <= MAX_RCP_BYTES)
                        incoming.emit(plaintext.toString(Charsets.UTF_8))
                        received++
                    } finally { plaintext.fill(0) }
                }
                else -> error("Unexpected channel record")
            }
        } catch (error: CancellationException) { throw error }
        catch (_: Exception) { close() }
    }
}
