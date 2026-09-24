package remora.spike.noise

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Noise rev. 34 §5.1 CipherState anchors: nonce layout, fail-closed AEAD, exhaustion. */
class CipherStateTest {
    @Test
    fun passthroughWithoutKey() {
        val cs = CipherState()
        cs.initializeKey(null)
        assertFalse(cs.hasKey())
        val message = utf8("frame")
        assertArrayEquals(message, cs.encryptWithAd(utf8("ad"), message))
        assertArrayEquals(message, cs.decryptWithAd(utf8("ad"), message))
        assertEquals(0uL, cs.nonce)
    }

    @Test
    fun nonceIsThirtyTwoZeroBitsThenLittleEndianCounter() {
        // §12.3: 32 zero bits ‖ LE64(n) — the exact 96-bit ChaCha20 nonce.
        assertEquals("000000000000000000000000", bytesToHex(noiseNonce(0u)))
        assertEquals("000000000100000000000000", bytesToHex(noiseNonce(1u)))
        assertEquals("00000000ff00000000000000", bytesToHex(noiseNonce(0xffu)))
        assertEquals("000000000001000000000000", bytesToHex(noiseNonce(0x100u)))
        assertEquals("00000000ffffffff00000000", bytesToHex(noiseNonce(0xffffffffu)))
        // 2^64-2 (last usable n): fe ff ff ff ff ff ff 00... wait: LE bytes at offset 4.
        assertEquals("00000000feffffffffffffff", bytesToHex(noiseNonce(MAX_NONCE - 1u)))
    }

    @Test
    fun initializeKeyCopiesTheKeyAndResetsTheNonce() {
        val key = ByteArray(DHLEN) { 0x33 }
        val cs = CipherState()
        cs.initializeKey(key)
        cs.encryptWithAd(EMPTY, utf8("a"))
        assertEquals(1uL, cs.nonce)
        // Mutating the caller's array must not break the state (initializeKey copies).
        key.fill(0)
        val ciphertext = cs.encryptWithAd(EMPTY, utf8("b"))
        val fresh = CipherState()
        fresh.initializeKey(ByteArray(DHLEN) { 0x33 })
        fresh.setNonce(1u)
        assertArrayEquals(utf8("b"), fresh.decryptWithAd(EMPTY, ciphertext))
    }

    @Test
    fun failsClosedOnTagMismatchAndDoesNotAdvanceN() {
        val tx = CipherState()
        tx.initializeKey(ByteArray(DHLEN) { 0x44 })
        val first = tx.encryptWithAd(utf8("ad"), utf8("frame-0")) // tx n: 0 → 1
        val second = tx.encryptWithAd(utf8("ad"), utf8("frame-1")) // tx n: 1 → 2

        val rx = CipherState()
        rx.initializeKey(ByteArray(DHLEN) { 0x44 })
        val tampered = first.copyOf()
        tampered[0] = (tampered[0].toInt() xor 0x01).toByte()
        assertNoiseError("aead_verification_failed") { rx.decryptWithAd(utf8("ad"), tampered) }
        assertEquals(0uL, rx.nonce) // failed decrypt must not consume the nonce
        assertArrayEquals(utf8("frame-0"), rx.decryptWithAd(utf8("ad"), first))
        assertEquals(1uL, rx.nonce)
        assertArrayEquals(utf8("frame-1"), rx.decryptWithAd(utf8("ad"), second))
        // Replay of an already-consumed frame fails and still does not advance n.
        assertNoiseError("aead_verification_failed") { rx.decryptWithAd(utf8("ad"), first) }
        assertEquals(2uL, rx.nonce)
    }

    @Test
    fun reservesTheMaximumNonceAndReportsExhaustion() {
        val cs = CipherState()
        cs.initializeKey(ByteArray(DHLEN) { 0x55 })
        cs.setNonce(MAX_NONCE - 1u)
        cs.encryptWithAd(EMPTY, utf8("last"))
        assertNoiseError("nonce_exhausted") { cs.encryptWithAd(EMPTY, utf8("next")) }
        assertNoiseError("nonce_exhausted") { cs.decryptWithAd(EMPTY, utf8("next")) }
        // Setting n directly to the reserved value fails on the next use too.
        cs.setNonce(MAX_NONCE)
        assertNoiseError("nonce_exhausted") { cs.encryptWithAd(EMPTY, utf8("nope")) }
    }

    @Test
    fun zeroizeWipesTheKeyAndRestoresPassthrough() {
        val cs = CipherState()
        cs.initializeKey(ByteArray(DHLEN) { 0x66 })
        cs.encryptWithAd(EMPTY, utf8("a"))
        cs.zeroize()
        assertFalse(cs.hasKey())
        assertEquals(0uL, cs.nonce)
        val message = utf8("passthrough")
        assertArrayEquals(message, cs.encryptWithAd(EMPTY, message))
        assertTrue(cs.encryptWithAd(EMPTY, message) === message)
    }

    @Test
    fun rejectsNonThirtyTwoByteKeys() {
        val cs = CipherState()
        assertNoiseError("invalid_key_length") { cs.initializeKey(ByteArray(16)) }
        assertNoiseError("invalid_key_length") { cs.initializeKey(ByteArray(33)) }
    }
}
