package io.github.lottooss.remora.core.crypto

import org.bouncycastle.crypto.InvalidCipherTextException
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class NoiseError(val code: String, message: String) : RuntimeException("Noise error [$code]: $message")

const val DHLEN = 32
const val HASHLEN = 32
const val TAGLEN = 16
const val MAX_NOISE_MESSAGE = 65535
const val MAX_TRANSPORT_PAYLOAD = MAX_NOISE_MESSAGE - TAGLEN
val MAX_NONCE: ULong = ULong.MAX_VALUE
val EMPTY: ByteArray = ByteArray(0)

private val secureRandom = SecureRandom()

data class Keypair(val secretKey: ByteArray, val publicKey: ByteArray)

fun generateKeypair(): Keypair {
    val secretKey = ByteArray(DHLEN)
    secureRandom.nextBytes(secretKey)
    return keypairFromSecret(secretKey)
}

fun keypairFromSecret(secretKey: ByteArray): Keypair {
    if (secretKey.size != DHLEN) throw NoiseError("invalid_key_length", "X25519 secret key must be 32 bytes")
    val publicKey = X25519PrivateKeyParameters(secretKey, 0).generatePublicKey().encoded
    return Keypair(secretKey, publicKey)
}

fun dh(secretKey: ByteArray, publicKey: ByteArray): ByteArray {
    if (secretKey.size != DHLEN || publicKey.size != DHLEN) {
        throw NoiseError("invalid_key_length", "X25519 keys must be 32 bytes")
    }
    try {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(secretKey, 0))
        val sharedSecret = ByteArray(DHLEN)
        agreement.calculateAgreement(X25519PublicKeyParameters(publicKey, 0), sharedSecret, 0)
        if (sharedSecret.all { it == 0.toByte() }) {
            throw NoiseError("invalid_public_key", "all-zero X25519 DH result (low-order public key)")
        }
        return sharedSecret
    } catch (error: NoiseError) {
        throw error
    } catch (error: RuntimeException) {
        throw NoiseError("invalid_public_key", "X25519 DH failed: ${error.message}")
    }
}

fun sha256(vararg data: ByteArray): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256")
    if (data.size == 1) return digest.digest(data[0])
    for (part in data) digest.update(part)
    return digest.digest()
}

fun hmacHash(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
}

fun hkdf2(chainingKey: ByteArray, inputKeyMaterial: ByteArray): Pair<ByteArray, ByteArray> {
    val tempKey = hmacHash(chainingKey, inputKeyMaterial)
    val output1 = hmacHash(tempKey, byteArrayOf(0x01))
    val output2 = hmacHash(tempKey, output1 + byteArrayOf(0x02))
    return output1 to output2
}

fun hkdf3(chainingKey: ByteArray, inputKeyMaterial: ByteArray): Triple<ByteArray, ByteArray, ByteArray> {
    val (output1, output2) = hkdf2(chainingKey, inputKeyMaterial)
    val tempKey = hmacHash(chainingKey, inputKeyMaterial)
    val output3 = hmacHash(tempKey, output2 + byteArrayOf(0x03))
    return Triple(output1, output2, output3)
}

fun noiseNonce(n: ULong): ByteArray {
    val nonce = ByteArray(12)
    val value = n.toLong()
    for (i in 0 until 8) {
        nonce[4 + i] = ((value ushr (8 * i)) and 0xff).toByte()
    }
    return nonce
}

fun encrypt(key: ByteArray, n: ULong, ad: ByteArray, plaintext: ByteArray): ByteArray {
    if (key.size != DHLEN) throw NoiseError("invalid_key_length", "cipher key must be 32 bytes")
    val cipher = ChaCha20Poly1305()
    cipher.init(true, ParametersWithIV(KeyParameter(key), noiseNonce(n)))
    if (ad.isNotEmpty()) cipher.processAADBytes(ad, 0, ad.size)
    val out = ByteArray(plaintext.size + TAGLEN)
    var length = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
    length += cipher.doFinal(out, length)
    return if (length == out.size) out else out.copyOf(length)
}

fun decrypt(key: ByteArray, n: ULong, ad: ByteArray, ciphertext: ByteArray): ByteArray {
    if (key.size != DHLEN) throw NoiseError("invalid_key_length", "cipher key must be 32 bytes")
    try {
        if (ciphertext.size < TAGLEN) {
            throw NoiseError("aead_verification_failed", "ChaCha20-Poly1305 verification failed")
        }
        val cipher = ChaCha20Poly1305()
        cipher.init(false, ParametersWithIV(KeyParameter(key), noiseNonce(n)))
        if (ad.isNotEmpty()) cipher.processAADBytes(ad, 0, ad.size)
        val out = ByteArray(ciphertext.size - TAGLEN)
        var length = cipher.processBytes(ciphertext, 0, ciphertext.size, out, 0)
        length += cipher.doFinal(out, length)
        return out
    } catch (error: NoiseError) {
        throw error
    } catch (error: InvalidCipherTextException) {
        throw NoiseError("aead_verification_failed", "ChaCha20-Poly1305 verification failed")
    }
}

fun encryptWithIv(key: ByteArray, iv: ByteArray, ad: ByteArray, plaintext: ByteArray): ByteArray {
    if (key.size != DHLEN) throw NoiseError("invalid_key_length", "cipher key must be 32 bytes")
    if (iv.size != 12) throw NoiseError("invalid_iv_length", "IV must be 12 bytes")
    val cipher = ChaCha20Poly1305()
    cipher.init(true, ParametersWithIV(KeyParameter(key), iv))
    if (ad.isNotEmpty()) cipher.processAADBytes(ad, 0, ad.size)
    val out = ByteArray(plaintext.size + TAGLEN)
    var length = cipher.processBytes(plaintext, 0, plaintext.size, out, 0)
    length += cipher.doFinal(out, length)
    return if (length == out.size) out else out.copyOf(length)
}

fun decryptWithIv(key: ByteArray, iv: ByteArray, ad: ByteArray, ciphertext: ByteArray): ByteArray {
    if (key.size != DHLEN) throw NoiseError("invalid_key_length", "cipher key must be 32 bytes")
    if (iv.size != 12) throw NoiseError("invalid_iv_length", "IV must be 12 bytes")
    try {
        if (ciphertext.size < TAGLEN) {
            throw NoiseError("aead_verification_failed", "ChaCha20-Poly1305 verification failed")
        }
        val cipher = ChaCha20Poly1305()
        cipher.init(false, ParametersWithIV(KeyParameter(key), iv))
        if (ad.isNotEmpty()) cipher.processAADBytes(ad, 0, ad.size)
        val out = ByteArray(ciphertext.size - TAGLEN)
        var length = cipher.processBytes(ciphertext, 0, ciphertext.size, out, 0)
        length += cipher.doFinal(out, length)
        return out
    } catch (error: NoiseError) {
        throw error
    } catch (error: InvalidCipherTextException) {
        throw NoiseError("aead_verification_failed", "ChaCha20-Poly1305 verification failed")
    }
}

fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

private fun padTo(bytes: ByteArray, size: Int): ByteArray {
    val out = ByteArray(size)
    System.arraycopy(bytes, 0, out, 0, bytes.size)
    return out
}

class CipherState {
    private var key: ByteArray? = null
    var nonce: ULong = 0u
        private set

    fun initializeKey(key: ByteArray?) {
        if (key != null && key.size != DHLEN) {
            throw NoiseError("invalid_key_length", "cipher key must be 32 bytes")
        }
        this.key = key?.copyOf()
        nonce = 0u
    }

    fun hasKey(): Boolean = key != null

    fun setNonce(nonce: ULong) {
        this.nonce = nonce
    }

    fun encryptWithAd(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val currentKey = key ?: return plaintext
        assertNonce()
        val ciphertext = encrypt(currentKey, nonce, ad, plaintext)
        nonce += 1u
        return ciphertext
    }

    fun decryptWithAd(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val currentKey = key ?: return ciphertext
        assertNonce()
        val plaintext = decrypt(currentKey, nonce, ad, ciphertext)
        nonce += 1u
        return plaintext
    }

    fun zeroize() {
        key?.fill(0)
        key = null
        nonce = 0u
    }

    private fun assertNonce() {
        if (nonce >= MAX_NONCE) throw NoiseError("nonce_exhausted", "transport nonce exhausted")
    }
}

class SymmetricState(protocolName: String) {
    val cipherState = CipherState()
    private var chainingKey: ByteArray
    private var handshakeHash: ByteArray

    init {
        val nameBytes = utf8(protocolName)
        handshakeHash = if (nameBytes.size <= HASHLEN) padTo(nameBytes, HASHLEN) else sha256(nameBytes)
        chainingKey = handshakeHash.copyOf()
        cipherState.initializeKey(null)
    }

    fun mixKey(inputKeyMaterial: ByteArray) {
        val (ck, tempK) = hkdf2(chainingKey, inputKeyMaterial)
        chainingKey = ck
        cipherState.initializeKey(tempK)
    }

    fun mixHash(data: ByteArray) {
        handshakeHash = sha256(handshakeHash, data)
    }

    fun mixKeyAndHash(inputKeyMaterial: ByteArray) {
        val (ck, tempH, tempK) = hkdf3(chainingKey, inputKeyMaterial)
        chainingKey = ck
        mixHash(tempH)
        cipherState.initializeKey(tempK)
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ciphertext = cipherState.encryptWithAd(handshakeHash, plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val plaintext = cipherState.decryptWithAd(handshakeHash, ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    fun split(): Pair<CipherState, CipherState> {
        val (tempK1, tempK2) = hkdf2(chainingKey, EMPTY)
        val c1 = CipherState()
        val c2 = CipherState()
        c1.initializeKey(tempK1)
        c2.initializeKey(tempK2)
        return c1 to c2
    }

    fun getHandshakeHash(): ByteArray {
        if (chainingKey.size != HASHLEN) throw NoiseError("invalid_key_length", "bad chaining key")
        return handshakeHash.copyOf()
    }
}

data class HandshakeResult(
    val send: CipherState,
    val recv: CipherState,
    val handshakeHash: ByteArray,
    val remoteStatic: ByteArray,
)

class HandshakeState(
    private val initiator: Boolean,
    prologue: ByteArray,
    private val staticKeypair: Keypair,
    remoteStatic: ByteArray? = null,
    psk: ByteArray? = null,
    ephemeralSecret: ByteArray? = null,
) {
    private val symmetric = SymmetricState(PROTOCOL_NAME)
    private var psk: ByteArray? = null
    private var ephemeralSecret: ByteArray? = null
    private var e: Keypair? = null
    private var rs: ByteArray? = null
    private var re: ByteArray? = null
    private var patternIndex = 0
    private var handshakeResult: HandshakeResult? = null

    init {
        if (psk != null && psk.size != DHLEN) {
            throw NoiseError("invalid_key_length", "PSK must be 32 bytes")
        }
        this.psk = psk
        this.ephemeralSecret = ephemeralSecret

        symmetric.mixHash(prologue)

        if (initiator) {
            if (remoteStatic == null) throw NoiseError("missing_key", "IK initiator must pin rs")
            if (remoteStatic.size != DHLEN) throw NoiseError("invalid_key_length", "rs must be 32 bytes")
            rs = remoteStatic
        }
        if (initiator) {
            symmetric.mixHash(rs ?: EMPTY)
        } else {
            symmetric.mixHash(staticKeypair.publicKey)
        }
    }

    val isComplete: Boolean get() = handshakeResult != null
    val result: HandshakeResult get() = handshakeResult ?: throw NoiseError("handshake_incomplete", "handshake not finished")
    val remoteStatic: ByteArray? get() = rs
    val handshakeHash: ByteArray get() = symmetric.getHandshakeHash()

    fun writeMessage(payload: ByteArray): ByteArray {
        assertActive()
        assertTurn(writing = true)
        val parts = mutableListOf<ByteArray>()
        for (token in MESSAGE_PATTERNS[patternIndex]) {
            val part = processWriteToken(token)
            if (part.isNotEmpty()) parts.add(part)
        }
        parts.add(symmetric.encryptAndHash(payload))
        val out = parts.reduce { a, b -> a + b }
        if (out.size > MAX_NOISE_MESSAGE) {
            throw NoiseError("message_too_long", "noise message exceeds 65535 bytes")
        }
        patternIndex += 1
        if (patternIndex == MESSAGE_PATTERNS.size) finishHandshake()
        return out
    }

    fun readMessage(message: ByteArray): ByteArray {
        assertActive()
        assertTurn(writing = false)
        if (message.size > MAX_NOISE_MESSAGE) {
            throw NoiseError("message_too_long", "noise message exceeds 65535 bytes")
        }
        var offset = 0
        for (token in MESSAGE_PATTERNS[patternIndex]) {
            offset = processReadToken(token, message, offset)
        }
        val ciphertext = message.copyOfRange(offset, message.size)
        val plaintext = symmetric.decryptAndHash(ciphertext)
        patternIndex += 1
        if (patternIndex == MESSAGE_PATTERNS.size) finishHandshake()
        return plaintext
    }

    private fun processWriteToken(token: Token): ByteArray = when (token) {
        Token.E -> {
            val secret = ephemeralSecret
            ephemeralSecret = null
            val ephemeral = if (secret == null) generateKeypair() else keypairFromSecret(secret)
            e = ephemeral
            symmetric.mixHash(ephemeral.publicKey)
            symmetric.mixKey(ephemeral.publicKey)
            ephemeral.publicKey
        }
        Token.S -> {
            symmetric.encryptAndHash(staticKeypair.publicKey)
        }
        Token.EE -> {
            symmetric.mixKey(dh(requireEphemeral().secretKey, requireRe()))
            EMPTY
        }
        Token.ES -> {
            val dhSecret = if (initiator) {
                dh(requireEphemeral().secretKey, requireRs())
            } else {
                dh(staticKeypair.secretKey, requireRe())
            }
            symmetric.mixKey(dhSecret)
            EMPTY
        }
        Token.SE -> {
            val dhSecret = if (initiator) {
                dh(staticKeypair.secretKey, requireRe())
            } else {
                dh(requireEphemeral().secretKey, requireRs())
            }
            symmetric.mixKey(dhSecret)
            EMPTY
        }
        Token.SS -> {
            symmetric.mixKey(dh(staticKeypair.secretKey, requireRs()))
            EMPTY
        }
        Token.PSK -> {
            val currentPsk = psk ?: throw NoiseError("missing_key", "PSK token encountered without a PSK")
            psk = null
            symmetric.mixKeyAndHash(currentPsk)
            EMPTY
        }
    }

    private fun processReadToken(token: Token, message: ByteArray, offset: Int): Int = when (token) {
        Token.E -> {
            val remoteEphemeral = slice(message, offset, DHLEN)
            re = remoteEphemeral
            symmetric.mixHash(remoteEphemeral)
            symmetric.mixKey(remoteEphemeral)
            offset + DHLEN
        }
        Token.S -> {
            val size = if (symmetric.cipherState.hasKey()) DHLEN + TAGLEN else DHLEN
            val remoteStaticCiphertext = slice(message, offset, size)
            val remoteStaticPlaintext = symmetric.decryptAndHash(remoteStaticCiphertext)
            if (remoteStaticPlaintext.size != DHLEN) {
                throw NoiseError("invalid_key_length", "decrypted remote static key is not 32 bytes")
            }
            rs = remoteStaticPlaintext
            offset + size
        }
        Token.EE -> {
            symmetric.mixKey(dh(requireEphemeral().secretKey, requireRe()))
            offset
        }
        Token.ES -> {
            val dhSecret = if (initiator) {
                dh(requireEphemeral().secretKey, requireRs())
            } else {
                dh(staticKeypair.secretKey, requireRe())
            }
            symmetric.mixKey(dhSecret)
            offset
        }
        Token.SE -> {
            val dhSecret = if (initiator) {
                dh(staticKeypair.secretKey, requireRe())
            } else {
                dh(requireEphemeral().secretKey, requireRs())
            }
            symmetric.mixKey(dhSecret)
            offset
        }
        Token.SS -> {
            symmetric.mixKey(dh(staticKeypair.secretKey, requireRs()))
            offset
        }
        Token.PSK -> {
            val currentPsk = psk ?: throw NoiseError("missing_key", "PSK token encountered without a PSK")
            psk = null
            symmetric.mixKeyAndHash(currentPsk)
            offset
        }
    }

    private fun finishHandshake() {
        val (c1, c2) = symmetric.split()
        val peerStatic = rs ?: throw NoiseError("missing_key", "peer static key missing at handshake completion")
        handshakeResult = if (initiator) {
            HandshakeResult(send = c1, recv = c2, handshakeHash = handshakeHash, remoteStatic = peerStatic)
        } else {
            HandshakeResult(send = c2, recv = c1, handshakeHash = handshakeHash, remoteStatic = peerStatic)
        }
        e?.secretKey?.fill(0)
        staticKeypair.secretKey.fill(0)
        psk = null
        ephemeralSecret = null
    }

    private fun assertActive() {
        if (patternIndex >= MESSAGE_PATTERNS.size) {
            throw NoiseError("handshake_exhausted", "handshake already finished")
        }
    }

    private fun assertTurn(writing: Boolean) {
        val initiatorWritesThisPattern = patternIndex % 2 == 0
        val callerIsInitiatorWriter = if (writing) initiator else !initiator
        if (initiatorWritesThisPattern != callerIsInitiatorWriter) {
            throw NoiseError("invalid_message", "out-of-turn handshake call")
        }
    }

    private fun requireEphemeral(): Keypair = e ?: throw NoiseError("invalid_message", "ephemeral key not available")
    private fun requireRs(): ByteArray = rs ?: throw NoiseError("invalid_message", "remote static key not available")
    private fun requireRe(): ByteArray = re ?: throw NoiseError("invalid_message", "remote ephemeral key not available")

    private fun slice(message: ByteArray, offset: Int, size: Int): ByteArray {
        if (offset + size > message.size) throw NoiseError("invalid_message", "handshake message truncated")
        return message.copyOfRange(offset, offset + size)
    }

    private enum class Token { E, S, EE, ES, SE, SS, PSK }

    companion object {
        const val PROTOCOL_NAME = "Noise_IKpsk2_25519_ChaChaPoly_SHA256"
        private val MESSAGE_PATTERNS: List<List<Token>> = listOf(
            listOf(Token.E, Token.ES, Token.S, Token.SS),
            listOf(Token.E, Token.EE, Token.SE, Token.PSK),
        )
    }
}
