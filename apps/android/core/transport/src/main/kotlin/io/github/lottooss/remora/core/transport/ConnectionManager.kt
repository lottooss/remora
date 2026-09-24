package io.github.lottooss.remora.core.transport

import io.github.lottooss.remora.core.crypto.Keypair
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class HostConnectionInfo(
    val hostId: String,
    val hostNoisePub: ByteArray,
    val relayOrigin: String,
    val deviceId: String,
    val relayPrivateKey: ByteArray,
    val noiseKeypair: Keypair,
    val devicePsk: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (javaClass != other?.javaClass) return false
        other as HostConnectionInfo
        return hostId == other.hostId &&
            hostNoisePub.contentEquals(other.hostNoisePub) &&
            relayOrigin == other.relayOrigin &&
            deviceId == other.deviceId &&
            relayPrivateKey.contentEquals(other.relayPrivateKey) &&
            noiseKeypair == other.noiseKeypair &&
            devicePsk.contentEquals(other.devicePsk)
    }

    override fun hashCode(): Int {
        var result = hostId.hashCode()
        result = 31 * result + hostNoisePub.contentHashCode()
        result = 31 * result + relayOrigin.hashCode()
        result = 31 * result + deviceId.hashCode()
        result = 31 * result + relayPrivateKey.contentHashCode()
        result = 31 * result + noiseKeypair.hashCode()
        result = 31 * result + devicePsk.contentHashCode()
        return result
    }

    override fun toString(): String {
        return "HostConnectionInfo(hostId=$hostId, deviceId=$deviceId, relayOrigin=$relayOrigin, [REDACTED])"
    }
}

/**
 * Manages foreground host connection, secure channel establishment, and RCP client lifecycle.
 */
class ConnectionManager(
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO + Job()),
) {

    private val _connectionState = MutableStateFlow(ConnectionState.Idle)
    val connectionState: StateFlow<ConnectionState> = _connectionState.asStateFlow()

    private val _activeHostId = MutableStateFlow<String?>(null)
    val activeHostId: StateFlow<String?> = _activeHostId.asStateFlow()

    private val _rcpClient = MutableStateFlow<RcpClient?>(null)
    val rcpClient: StateFlow<RcpClient?> = _rcpClient.asStateFlow()

    private var currentRelayClient: RelayClient? = null
    private var currentSecureChannel: SecureChannel? = null
    private var connectionJob: Job? = null

    fun connect(info: HostConnectionInfo) {
        disconnect()
        _activeHostId.value = info.hostId
        _connectionState.value = ConnectionState.Connecting

        connectionJob = scope.launch {
            try {
                val relayClient = RelayClient(
                    relayOrigin = info.relayOrigin,
                    deviceId = info.deviceId,
                    relayPrivateKey = info.relayPrivateKey,
                )
                currentRelayClient = relayClient

                // Observe relay state
                launch {
                    relayClient.connectionState.collect { rlyState ->
                        if (rlyState == ConnectionState.Ready && _connectionState.value != ConnectionState.Ready) {
                            _connectionState.value = ConnectionState.Handshaking
                            openSecureChannel(info, relayClient)
                        } else if (rlyState == ConnectionState.Backoff || rlyState == ConnectionState.Idle) {
                            _connectionState.value = rlyState
                        }
                    }
                }

                relayClient.connect()
            } catch (e: Exception) {
                _connectionState.value = ConnectionState.Idle
            }
        }
    }

    private suspend fun openSecureChannel(info: HostConnectionInfo, relayClient: RelayClient) {
        try {
            val channel = SecureChannel(
                hostId = info.hostId,
                deviceId = info.deviceId,
                hostNoisePub = info.hostNoisePub,
                deviceNoiseKeypair = info.noiseKeypair,
                relayClient = relayClient,
            )
            currentSecureChannel = channel

            val sessionPayload = """{"v":1,"purpose":"session","app":{"version":"1.0.0"}}"""
            channel.handshake(
                purpose = "session",
                psk = info.devicePsk,
                msg1PayloadJson = sessionPayload,
            )

            val rcp = RcpClient(channel)
            _rcpClient.value = rcp
            _connectionState.value = ConnectionState.Ready
        } catch (e: Exception) {
            _connectionState.value = ConnectionState.Backoff
        }
    }

    fun disconnect() {
        connectionJob?.cancel()
        connectionJob = null

        _rcpClient.value?.close()
        _rcpClient.value = null

        currentSecureChannel?.close()
        currentSecureChannel = null

        currentRelayClient?.disconnect()
        currentRelayClient = null

        _activeHostId.value = null
        _connectionState.value = ConnectionState.Idle
    }
}
