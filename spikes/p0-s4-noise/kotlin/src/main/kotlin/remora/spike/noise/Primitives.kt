package remora.spike.noise

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

/**
 * Primitive wrappers for Noise_IKpsk2_25519_ChaChaPoly_SHA256 (Noise rev. 34 §4, §12).
 * All math comes from BouncyCastle; this module only assembles them into the framework's
 * DH / cipher / hash / HKDF contracts. No primitive is implemented here.
 */

const val DHLEN = 32
const val HASHLEN = 32
const val TAGLEN = 16
/** Noise rev. 34 §3: every handshake and transport message is ≤ 65535 bytes. */
const val MAX_NOISE_MESSAGE = 65535
/** Largest transport plaintext: 65535 minus the 16-byte AEAD tag. */
const val MAX_TRANSPORT_PAYLOAD = MAX_NOISE_MESSAGE - TAGLEN

/** The maximum n (2^64-1) is reserved (§5.1); ULong comparisons are unsigned. */
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

/**
 * DH(key_pair, public_key): 32-byte shared secret. BouncyCastle computes X25519 for any
 * 32-byte input, so an all-zero result (low-order public key) is rejected explicitly —
 * matching the TS twin's noble behaviour (invalid_public_key).
 */
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

fun hash(vararg data: ByteArray): ByteArray {
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

/**
 * Noise rev. 34 §4.3 HKDF: temp_key = HMAC(ck, ikm); outputs are the HMAC chain
 * 0x01, 0x02, 0x03. Distinct from RFC 5869 only in call convention, not in math.
 */
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

/**
 * Noise rev. 34 §12.3: the 96-bit ChaCha20 nonce is 32 zero bits followed by
 * the 64-bit counter n in little-endian order (NOT big-endian; AESGCM is the
 * big-endian sibling). ULong is always in range, so no range check here.
 */
fun noiseNonce(n: ULong): ByteArray {
    val nonce = ByteArray(12)
    val value = n.toLong()
    for (i in 0 until 8) {
        nonce[4 + i] = ((value ushr (8 * i)) and 0xff).toByte()
    }
    return nonce
}

/** ENCRYPT(k, n, ad, plaintext) with ChaCha20-Poly1305 (RFC 8439 AEAD). */
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

/** DECRYPT(k, n, ad, ciphertext); any tag mismatch raises (mirrors the TS catch-all). */
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

fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)
