package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.crypto.decodeBase64Url
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
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.security.SecureRandom

sealed interface PairingFlowState {
    data object Idle : PairingFlowState
    data object Scanning : PairingFlowState
    data class Enrolling(val hostName: String) : PairingFlowState
    data class ConfirmingSas(val sasCode: String, val hostName: String) : PairingFlowState
    data class Success(val hostId: String, val hostName: String) : PairingFlowState
    data class Error(val message: String) : PairingFlowState
}

/**
 * Orchestrates the complete pairing protocol (Crypto/1 §5, RLY/1 §4.2, RCP/1 §7).
 */
class PairingService(
    private val hostRepository: HostRepository,
    private val keyStorage: KeyStorage,
    private val approvalKeyManager: ApprovalKeyManager = ApprovalKeyManager(),
) {
    private val json = Json { ignoreUnknownKeys = true }
    private val _pairingState = MutableStateFlow<PairingFlowState>(PairingFlowState.Idle)
    val pairingState: StateFlow<PairingFlowState> = _pairingState.asStateFlow()

    suspend fun startPairing(qrString: String, deviceName: String = "Android Phone") {
        try {
            val qrData = parsePairingQr(qrString)
            if (System.currentTimeMillis() / 1000 > qrData.expiry) {
                _pairingState.value = PairingFlowState.Error("QR code has expired")
                return
            }

            _pairingState.value = PairingFlowState.Enrolling(qrData.hostName)

            // 1. Generate keys
            val relayPrivKey = ByteArray(32)
            SecureRandom().nextBytes(relayPrivKey)
            val relayPubKey = getRelayPublicKey(relayPrivKey)

            val deviceNoiseKeypair = generateKeypair()

            val approvalKey = try {
                approvalKeyManager.getOrCreateApprovalKey(qrData.hostId)
            } catch (_: Exception) {
                null
            }
            val approvalPubSpki = approvalKey?.publicKeySpkiDer ?: ByteArray(91) { 0x30 }

            // 2. Relay enrollment
            val (deviceId, _) = RelayClient.enrollDevice(
                relayOrigin = qrData.relayOrigin,
                ticket = qrData.ticket,
                relayPub = relayPubKey,
                name = deviceName,
                platform = "android",
            )

            // 3. Connect to relay
            val relayClient = RelayClient(
                relayOrigin = qrData.relayOrigin,
                deviceId = deviceId,
                relayPrivateKey = relayPrivKey,
            )
            relayClient.connect()

            // Wait for relay ready
            withTimeout(10_000) {
                relayClient.connectionState.first { it == ConnectionState.Ready }
            }

            // 4. Noise pairing handshake
            val secureChannel = SecureChannel(
                hostId = qrData.hostId,
                deviceId = deviceId,
                hostNoisePub = qrData.hostNoisePub,
                deviceNoiseKeypair = deviceNoiseKeypair,
                relayClient = relayClient,
            )

            val ticketId = "t_" + encodeBase32(qrData.ticket.sliceArray(0 until 16))
            val pairPsk = derivePairPsk(qrData.pairingSecret, ticketId)

            val msg1Payload = buildJsonObject {
                put("v", 1)
                put("purpose", "pair")
                put("deviceId", deviceId)
                put("relayPub", encodeBase64Url(relayPubKey))
                put("name", deviceName)
                put("platform", "android")
                put("approvalPub", encodeBase64Url(approvalPubSpki))
                put("app", buildJsonObject { put("version", "1.0.0") })
            }.toString()

            val (_, sasCode) = secureChannel.handshake(
                purpose = "pair",
                psk = pairPsk,
                msg1PayloadJson = msg1Payload,
            )

            val formattedSas = if (sasCode != null && sasCode.length == 6) {
                sasCode.substring(0, 3) + " " + sasCode.substring(3, 6)
            } else {
                sasCode ?: "------"
            }

            _pairingState.value = PairingFlowState.ConfirmingSas(formattedSas, qrData.hostName)

            // 5. Await pair.complete RCP message
            val completeMessageText = withTimeout(120_000) {
                secureChannel.incomingMessages.first { msg ->
                    msg.contains("pair.complete")
                }
            }

            val completeRoot = json.parseToJsonElement(completeMessageText).jsonObject
            val params = completeRoot["p"]?.jsonObject
                ?: throw IllegalStateException("pair.complete missing params")

            val devicePskB64u = params["devicePsk"]?.jsonPrimitive?.content
                ?: throw IllegalStateException("pair.complete missing devicePsk")
            val pushKeyB64u = params["pushKey"]?.jsonPrimitive?.content
                ?: throw IllegalStateException("pair.complete missing pushKey")

            val devicePsk = decodeBase64Url(devicePskB64u)
            val pushKey = decodeBase64Url(pushKeyB64u)

            // Respond to pair.complete
            val responseMsg = """{"k":"res","id":1,"ok":true,"r":{"ok":true}}"""
            secureChannel.sendTransport(responseMsg)

            // 6. Save keys and host
            val hostKeys = HostKeyMaterial(
                hostId = qrData.hostId,
                deviceId = deviceId,
                relayPrivKey = relayPrivKey,
                relayPubKey = relayPubKey,
                noisePrivKey = deviceNoiseKeypair.secretKey,
                noisePubKey = deviceNoiseKeypair.publicKey,
                devicePsk = devicePsk,
                pushKey = pushKey,
                approvalPubSpki = approvalPubSpki,
            )
            keyStorage.saveHostKeys(qrData.hostId, hostKeys)

            val newHost = Host(
                id = HostId(qrData.hostId),
                name = qrData.hostName,
                relayOrigin = qrData.relayOrigin,
                hostNoisePub = qrData.hostNoisePub,
                isOnline = true,
                lastSeenAt = System.currentTimeMillis(),
            )
            hostRepository.addHost(newHost)

            // Clean up pairing channel
            secureChannel.close()
            relayClient.disconnect()

            _pairingState.value = PairingFlowState.Success(qrData.hostId, qrData.hostName)
        } catch (e: Exception) {
            _pairingState.value = PairingFlowState.Error(e.message ?: "Pairing failed")
        }
    }

    fun reset() {
        _pairingState.value = PairingFlowState.Idle
    }
}
