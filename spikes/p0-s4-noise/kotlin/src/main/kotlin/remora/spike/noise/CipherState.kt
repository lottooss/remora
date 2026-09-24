package remora.spike.noise

/** Noise rev. 34 §5.1 CipherState: the (k, n) AEAD counter state. */
class CipherState {
    private var key: ByteArray? = null

    /** Current 64-bit nonce (test/diagnostic access). */
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

    /** §5.1 SetNonce: used by tests to reach exhaustion quickly; SC/1 never reorders. */
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
        // On authentication failure n must NOT advance (§5.1).
        val plaintext = decrypt(currentKey, nonce, ad, ciphertext)
        nonce += 1u
        return plaintext
    }

    /** Best-effort wipe of the key material this object owns. */
    fun zeroize() {
        key?.fill(0)
        key = null
        nonce = 0u
    }

    private fun assertNonce() {
        // The maximum n (2^64-1) is reserved; reaching it means exhaustion (§5.1).
        if (nonce >= MAX_NONCE) throw NoiseError("nonce_exhausted", "transport nonce exhausted")
    }
}
