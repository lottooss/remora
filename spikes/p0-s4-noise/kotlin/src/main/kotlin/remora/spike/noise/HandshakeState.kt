package remora.spike.noise

/**
 * Noise_IKpsk2_25519_ChaChaPoly_SHA256 HandshakeState (Noise rev. 34 §5.3, §7.5 IK, §9 psk).
 *
 * Scope is deliberately minimal — this pattern only, as a spike for SC/1:
 *
 *   IKpsk2:
 *     <- s                 (pre-message: initiator knows the responder static key)
 *     ...
 *     -> e, es, s, ss      (message 1)
 *     <- e, ee, se, psk    (message 2)
 *
 * Ownership: the static secret, injected ephemeral secret, and psk passed to
 * the constructor belong to the state and are zeroized when the handshake splits.
 */
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
        // IK pre-message "<- s": both sides hash the responder public static key.
        if (initiator) {
            symmetric.mixHash(rs ?: EMPTY)
        } else {
            symmetric.mixHash(staticKeypair.publicKey)
        }
    }

    val isComplete: Boolean
        get() = handshakeResult != null

    val result: HandshakeResult
        get() = handshakeResult ?: throw NoiseError("handshake_incomplete", "handshake not finished")

    /** Peer static key once message 1 has been read (session admission gate). */
    val remoteStatic: ByteArray?
        get() = rs

    /** Current handshake hash h (channel binding once complete). */
    val handshakeHash: ByteArray
        get() = symmetric.getHandshakeHash()

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
            throw NoiseError("message_too_large", "handshake message ${out.size} bytes exceeds 65535")
        }
        patternIndex += 1
        if (patternIndex == MESSAGE_PATTERNS.size) finish()
        return out
    }

    fun readMessage(message: ByteArray): ByteArray {
        assertActive()
        assertTurn(writing = false)
        var offset = 0
        for (token in MESSAGE_PATTERNS[patternIndex]) {
            offset = processReadToken(token, message, offset)
        }
        if (offset > message.size) throw NoiseError("invalid_message", "handshake message truncated")
        val payload = symmetric.decryptAndHash(message.copyOfRange(offset, message.size))
        patternIndex += 1
        if (patternIndex == MESSAGE_PATTERNS.size) finish()
        return payload
    }

    private fun processWriteToken(token: Token): ByteArray = when (token) {
        Token.E -> {
            val secret = ephemeralSecret
            ephemeralSecret = null
            val ephemeral = if (secret == null) generateKeypair() else keypairFromSecret(secret)
            e = ephemeral
            symmetric.mixHash(ephemeral.publicKey)
            // PSK handshake (§9.2): every "e" in a message pattern is followed by MixKey(e.public_key).
            symmetric.mixKey(ephemeral.publicKey)
            ephemeral.publicKey
        }
        Token.S -> symmetric.encryptAndHash(staticKeypair.publicKey)
        Token.EE -> {
            symmetric.mixKey(dh(requireEphemeral().secretKey, requireRe()))
            EMPTY
        }
        Token.ES -> {
            symmetric.mixKey(
                if (initiator) dh(requireEphemeral().secretKey, requireRs())
                else dh(staticKeypair.secretKey, requireRe()),
            )
            EMPTY
        }
        Token.SE -> {
            symmetric.mixKey(
                if (initiator) dh(staticKeypair.secretKey, requireRe())
                else dh(requireEphemeral().secretKey, requireRs()),
            )
            EMPTY
        }
        Token.SS -> {
            symmetric.mixKey(dh(staticKeypair.secretKey, requireRs()))
            EMPTY
        }
        Token.PSK -> {
            symmetric.mixKeyAndHash(takePsk())
            EMPTY
        }
    }

    private fun processReadToken(token: Token, message: ByteArray, offset: Int): Int = when (token) {
        Token.E -> {
            val remoteEphemeral = slice(message, offset, DHLEN)
            re = remoteEphemeral
            symmetric.mixHash(remoteEphemeral)
            // PSK handshake (§9.2).
            symmetric.mixKey(remoteEphemeral)
            offset + DHLEN
        }
        Token.S -> {
            val size = if (symmetric.cipherState.hasKey()) DHLEN + 16 else DHLEN
            val peerStatic = symmetric.decryptAndHash(slice(message, offset, size))
            if (peerStatic.size != DHLEN) throw NoiseError("invalid_message", "bad static key length")
            if (rs != null) throw NoiseError("invalid_message", "static key already set")
            rs = peerStatic
            offset + size
        }
        Token.EE -> {
            symmetric.mixKey(dh(requireEphemeral().secretKey, requireRe()))
            offset
        }
        Token.ES -> {
            symmetric.mixKey(
                if (initiator) dh(requireEphemeral().secretKey, requireRs())
                else dh(staticKeypair.secretKey, requireRe()),
            )
            offset
        }
        Token.SE -> {
            symmetric.mixKey(
                if (initiator) dh(staticKeypair.secretKey, requireRe())
                else dh(requireEphemeral().secretKey, requireRs()),
            )
            offset
        }
        Token.SS -> {
            symmetric.mixKey(dh(staticKeypair.secretKey, requireRs()))
            offset
        }
        Token.PSK -> {
            symmetric.mixKeyAndHash(takePsk())
            offset
        }
    }

    private fun takePsk(): ByteArray {
        val currentPsk = psk ?: throw NoiseError("psk_missing", "pattern requires a psk")
        psk = null
        return currentPsk
    }

    private fun finish() {
        val (c1, c2) = symmetric.split()
        val handshakeHash = symmetric.getHandshakeHash()
        val peerStatic = rs ?: throw NoiseError("missing_key", "peer static key never learned")
        handshakeResult = if (initiator) {
            HandshakeResult(send = c1, recv = c2, handshakeHash = handshakeHash, remoteStatic = peerStatic)
        } else {
            HandshakeResult(send = c2, recv = c1, handshakeHash = handshakeHash, remoteStatic = peerStatic)
        }
        // Constraint: zeroize ephemeral (and now unused static) secrets after split().
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

    private fun requireEphemeral(): Keypair =
        e ?: throw NoiseError("invalid_message", "ephemeral key not available")

    private fun requireRs(): ByteArray =
        rs ?: throw NoiseError("invalid_message", "remote static key not available")

    private fun requireRe(): ByteArray =
        re ?: throw NoiseError("invalid_message", "remote ephemeral key not available")

    private fun slice(message: ByteArray, offset: Int, size: Int): ByteArray {
        if (offset + size > message.size) throw NoiseError("invalid_message", "handshake message truncated")
        return message.copyOfRange(offset, offset + size)
    }

    private enum class Token { E, S, EE, ES, SE, SS, PSK }

    companion object {
        /** The canonical protocol name; > HASHLEN so InitializeSymmetric hashes it. */
        const val PROTOCOL_NAME = "Noise_IKpsk2_25519_ChaChaPoly_SHA256"

        /** IK pattern (§7.5) + psk2 modifier: the "psk" token ends message 2 (§9.4). */
        private val MESSAGE_PATTERNS: List<List<Token>> = listOf(
            listOf(Token.E, Token.ES, Token.S, Token.SS),
            listOf(Token.E, Token.EE, Token.SE, Token.PSK),
        )
    }
}

/** Transport (or finished-handshake) cipher pair plus the channel-binding material. */
data class HandshakeResult(
    /** Transport cipher for messages this side sends. */
    val send: CipherState,
    /** Transport cipher for messages this side receives. */
    val recv: CipherState,
    val handshakeHash: ByteArray,
    /** Peer static public key (learned by the reader of message 1). */
    val remoteStatic: ByteArray,
)
