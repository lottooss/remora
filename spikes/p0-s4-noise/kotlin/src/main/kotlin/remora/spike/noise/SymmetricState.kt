package remora.spike.noise

/** Noise rev. 34 §5.2 SymmetricState: CipherState plus ck and h. */
class SymmetricState(protocolName: String) {
    val cipherState = CipherState()
    private var chainingKey: ByteArray
    private var handshakeHash: ByteArray

    init {
        val nameBytes = utf8(protocolName)
        // §5.2 InitializeSymmetric: name ≤ HASHLEN is zero-padded into h, else h = HASH(name).
        handshakeHash = if (nameBytes.size <= HASHLEN) padTo(nameBytes, HASHLEN) else hash(nameBytes)
        chainingKey = handshakeHash.copyOf()
        cipherState.initializeKey(null)
    }

    fun mixKey(inputKeyMaterial: ByteArray) {
        val (ck, tempK) = hkdf2(chainingKey, inputKeyMaterial)
        chainingKey = ck
        cipherState.initializeKey(tempK)
    }

    fun mixHash(data: ByteArray) {
        handshakeHash = hash(handshakeHash, data)
    }

    /** §9.1 MixKeyAndHash: used only by the "psk" token. */
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

    /** §5.2 Split: (c1, c2) = HKDF(ck, zerolen, 2); c1 carries initiator → responder. */
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

    private fun padTo(bytes: ByteArray, length: Int): ByteArray {
        val out = ByteArray(length)
        bytes.copyInto(out)
        return out
    }
}
