package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.crypto.PairingData
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.deriveEndpointId
import io.github.lottooss.remora.core.crypto.derivePairPsk
import io.github.lottooss.remora.core.crypto.encodeBase32
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.crypto.generateKeypair
import io.github.lottooss.remora.core.crypto.getRelayPublicKey
import io.github.lottooss.remora.core.crypto.parsePairingQr
import io.github.lottooss.remora.core.model.Host
import io.github.lottooss.remora.core.model.HostId
import io.github.lottooss.remora.core.security.ApprovalKeyManager
import io.github.lottooss.remora.core.security.HostKeyMaterial
import io.github.lottooss.remora.core.security.KeyStorage
import io.github.lottooss.remora.core.transport.ConnectionState
import io.github.lottooss.remora.core.transport.RelayClient
import io.github.lottooss.remora.core.transport.SecureChannel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.net.URI
import java.security.SecureRandom

enum class PairingError { INVALID_QR, EXPIRED_QR, INSECURE_RELAY, ALREADY_PAIRED, KEY_UNAVAILABLE,
    CONNECTION_FAILED, REJECTED, INVALID_RESPONSE, STORAGE_FAILED, TIMED_OUT }

sealed interface PairingFlowState {
    data object Idle : PairingFlowState
    data object Scanning : PairingFlowState
    data class Enrolling(val hostName: String) : PairingFlowState
    data class ConfirmingSas(val sasCode: String, val hostName: String) : PairingFlowState
    data class Success(val hostId: String, val hostName: String) : PairingFlowState
    data class Error(val code: PairingError) : PairingFlowState
}

private class PairingFailure(val code: PairingError) : IllegalStateException("Pairing failed")

/** Shared camera/manual validation boundary; no secrets are returned to feature code. */
fun validatePairingPayload(qr: String, nowSeconds: Long = System.currentTimeMillis() / 1000): PairingError? {
    return try {
        val payload = parseValidatedPairing(qr, nowSeconds)
        payload.pairingSecret.fill(0)
        payload.ticket.fill(0)
        null
    } catch (error: PairingFailure) {
        error.code
    }
}

private fun parseValidatedPairing(qr: String, nowSeconds: Long): PairingData {
    var parsed: PairingData? = null
    try {
        require(qr.length in 1..4096)
        val payload = parsePairingQr(qr)
        parsed = payload
        val origin = URI(payload.relayOrigin)
        if (origin.scheme != "https") throw PairingFailure(PairingError.INSECURE_RELAY)
        require(!origin.host.isNullOrEmpty() && origin.rawUserInfo == null && origin.rawQuery == null &&
            origin.rawFragment == null && origin.rawPath.isNullOrEmpty() &&
            (origin.port == -1 || origin.port in 1..65535))
        require(payload.hostId.matches(Regex("h_[a-z2-7]{26}")))
        require(payload.hostName.none { it.isISOControl() })
        if (payload.expiry <= nowSeconds) throw PairingFailure(PairingError.EXPIRED_QR)
        require(payload.expiry - nowSeconds <= 600)
        return payload
    } catch (error: Exception) {
        parsed?.pairingSecret?.fill(0)
        parsed?.ticket?.fill(0)
        if (error is PairingFailure) throw error
        throw PairingFailure(PairingError.INVALID_QR)
    }
}

/** Pair only after pinned Noise authentication and explicit confirmation on the PC. */
class PairingService(
    private val hostRepository: HostRepository,
    private val keyStorage: KeyStorage,
    private val approvalKeyManager: ApprovalKeyManager,
) {
    private val json = Json { ignoreUnknownKeys = false }
    private val mutex = Mutex()
    private var activeJob: Job? = null
    private val mutableState = MutableStateFlow<PairingFlowState>(PairingFlowState.Idle)
    val pairingState: StateFlow<PairingFlowState> = mutableState.asStateFlow()

    suspend fun startPairing(qrString: String, deviceName: String = "Android Phone") {
        if (!mutex.tryLock()) return
        var qr: PairingData? = null
        var relay: RelayClient? = null
        var channel: SecureChannel? = null
        var keys: HostKeyMaterial? = null
        val secrets = mutableListOf<ByteArray>()
        var createdApprovalKey = false
        var keysSaved = false
        var hostSaved = false
        var completed = false
        var phase = PairingError.CONNECTION_FAILED
        try {
            supervisorScope {
                activeJob = currentCoroutineContext().job
                val payload = parseValidatedPairing(qrString, System.currentTimeMillis() / 1000)
                qr = payload
                if (hostRepository.hosts.value.any { it.id.value == payload.hostId }) {
                    throw PairingFailure(PairingError.ALREADY_PAIRED)
                }
                require(deviceName.length in 1..40 && deviceName.none { it.isISOControl() })
                mutableState.value = PairingFlowState.Enrolling(payload.hostName)
                phase = PairingError.KEY_UNAVAILABLE
                // Pairing cannot replace an existing host; an unregistered leftover key
                // from an interrupted attempt can be discarded before generating a new key.
                val approval = withContext(Dispatchers.IO) {
                    approvalKeyManager.deleteApprovalKey(payload.hostId)
                    createdApprovalKey = true
                    approvalKeyManager.getOrCreateApprovalKey(payload.hostId)
                }
                val relayPrivate = ByteArray(32).also { SecureRandom().nextBytes(it) }
                secrets += relayPrivate
                val relayPublic = getRelayPublicKey(relayPrivate)
                val noise = generateKeypair()
                secrets += noise.secretKey
                phase = PairingError.CONNECTION_FAILED
                val (deviceId, enrolledHostId) = withTimeout(20_000) {
                    RelayClient.enrollDevice(payload.relayOrigin, payload.ticket, relayPublic, deviceName, "android")
                }
                if (deviceId != deriveEndpointId("d_", relayPublic) || enrolledHostId != payload.hostId) {
                    throw PairingFailure(PairingError.INVALID_RESPONSE)
                }
                val relayClient = RelayClient(payload.relayOrigin, deviceId, relayPrivate, scope = this)
                relay = relayClient
                relayClient.connect()
                withTimeout(10_000) { relayClient.connectionState.first { it == ConnectionState.Ready } }
                val secureChannel = SecureChannel(hostId = payload.hostId, deviceId = deviceId,
                    hostNoisePub = payload.hostNoisePub, deviceNoiseKeypair = noise, relayClient = relayClient,
                    scope = this)
                channel = secureChannel
                // Subscribe before msg1 so a prompt PC confirmation cannot lose pair.complete.
                val completion = async(start = CoroutineStart.UNDISPATCHED) {
                    withTimeout(120_000) { secureChannel.incomingMessages.first() }
                }
                try {
                    val ticketId = "t_" + encodeBase32(payload.ticket.copyOfRange(0, 16))
                    val pairPsk = derivePairPsk(payload.pairingSecret, ticketId)
                    secrets += pairPsk
                    val message = buildJsonObject {
                        put("v", 1); put("purpose", "pair"); put("deviceId", deviceId)
                        put("relayPub", encodeBase64Url(relayPublic)); put("name", deviceName)
                        put("platform", "android"); put("approvalPub", encodeBase64Url(approval.publicKeySpkiDer))
                        put("app", buildJsonObject { put("version", "1.0.0") })
                    }
                    val (_, sas) = secureChannel.handshake("pair", pairPsk, message.toString())
                    if (sas == null || !sas.matches(Regex("[0-9]{6}"))) {
                        throw PairingFailure(PairingError.INVALID_RESPONSE)
                    }
                    mutableState.value = PairingFlowState.ConfirmingSas(sas.chunked(3).joinToString(" "), payload.hostName)
                    val completeMessage = select<String> {
                        completion.onAwait { it }
                        secureChannel.closed.onAwait { throw PairingFailure(PairingError.CONNECTION_FAILED) }
                    }
                    val response = parseCompletion(completeMessage, payload.hostId)
                    val params = response.getValue("p").jsonObject
                    val devicePsk = decodeSecret(params, "devicePsk").also { secrets += it }
                    val pushKey = decodeSecret(params, "pushKey").also { secrets += it }
                    val material = HostKeyMaterial(payload.hostId, deviceId, relayPrivate, relayPublic,
                        noise.secretKey, noise.publicKey, devicePsk, pushKey, approval.publicKeySpkiDer)
                    keys = material
                    phase = PairingError.STORAGE_FAILED
                    keyStorage.saveHostKeys(payload.hostId, material)
                    keysSaved = true
                    hostRepository.addHost(Host(HostId(payload.hostId), payload.hostName, payload.relayOrigin,
                        payload.hostNoisePub.copyOf(), isOnline = false, lastSeenAt = System.currentTimeMillis()))
                    hostSaved = true
                    // RCP requires persistence before acknowledging the exact request id.
                    secureChannel.sendTransport(buildJsonObject {
                        put("k", "res"); put("id", response.getValue("id")); put("ok", true)
                        put("r", buildJsonObject { put("stored", true) })
                    }.toString())
                    completed = true
                    mutableState.value = PairingFlowState.Success(payload.hostId, payload.hostName)
                } finally {
                    completion.cancel()
                    secureChannel.close()
                    relayClient.disconnect()
                }
            }
        } catch (_: TimeoutCancellationException) {
            mutableState.value = PairingFlowState.Error(PairingError.TIMED_OUT)
        } catch (cancelled: CancellationException) {
            mutableState.value = PairingFlowState.Idle
            throw cancelled
        } catch (error: PairingFailure) {
            mutableState.value = PairingFlowState.Error(error.code)
        } catch (_: Exception) {
            mutableState.value = PairingFlowState.Error(phase)
        } finally {
            channel?.close()
            relay?.disconnect()
            withContext(NonCancellable + Dispatchers.IO) {
                val hostId = qr?.hostId
                if (!completed && hostId != null) {
                    var cleanupFailed = false
                    if (hostSaved) try { hostRepository.removeHost(HostId(hostId)) }
                        catch (_: Exception) { cleanupFailed = true }
                    if (keysSaved) try { keyStorage.deleteHostKeys(hostId) }
                        catch (_: Exception) { cleanupFailed = true }
                    if (createdApprovalKey) try { approvalKeyManager.deleteApprovalKey(hostId) }
                        catch (_: Exception) { cleanupFailed = true }
                    if (cleanupFailed) {
                        mutableState.value = PairingFlowState.Error(PairingError.STORAGE_FAILED)
                    }
                }
            }
            keys?.wipe()
            secrets.forEach { it.fill(0) }
            qr?.ticket?.fill(0)
            qr?.pairingSecret?.fill(0)
            activeJob = null
            mutex.unlock()
        }
    }

    fun reset() {
        activeJob?.cancel()
        mutableState.value = PairingFlowState.Idle
    }

    private fun parseCompletion(raw: String, hostId: String): JsonObject {
        try {
            require(raw.toByteArray(Charsets.UTF_8).size <= 49_152)
            val root = json.parseToJsonElement(raw).jsonObject
            if (root["k"]?.jsonPrimitive?.content == "evt" &&
                root["m"]?.jsonPrimitive?.content == "pair.rejected") throw PairingFailure(PairingError.REJECTED)
            require(root["k"]?.jsonPrimitive?.content == "req" &&
                root["m"]?.jsonPrimitive?.content == "pair.complete")
            val id = root["id"] as? JsonPrimitive
            require(id != null && !id.isString && id.longOrNull?.let { it in 1..9_007_199_254_740_991L } == true)
            val host = root.getValue("p").jsonObject.getValue("host").jsonObject
            require(host["id"]?.jsonPrimitive?.content == hostId)
            require(host.getValue("versions").jsonObject.getValue("rcp").jsonArray.any { it.jsonPrimitive.intOrNull == 1 })
            return root
        } catch (error: Exception) {
            if (error is PairingFailure) throw error
            throw PairingFailure(PairingError.INVALID_RESPONSE)
        }
    }

    private fun decodeSecret(params: JsonObject, key: String): ByteArray {
        try {
            val encoded = params.getValue(key).jsonPrimitive
            require(encoded.isString && encoded.content.length == 43)
            val bytes = decodeBase64Url(encoded.content)
            if (bytes.size != 32 || encodeBase64Url(bytes) != encoded.content) {
                bytes.fill(0)
                throw PairingFailure(PairingError.INVALID_RESPONSE)
            }
            return bytes
        } catch (_: Exception) {
            throw PairingFailure(PairingError.INVALID_RESPONSE)
        }
    }
}
