package io.github.lottooss.remora

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.openPushPayload
import io.github.lottooss.remora.core.crypto.PushContext
import io.github.lottooss.remora.core.data.HostRepository
import io.github.lottooss.remora.core.data.PushTokenRegistrar
import io.github.lottooss.remora.core.security.KeyStorage
import io.github.lottooss.remora.notification.RemoraNotificationChannel
import io.github.lottooss.remora.notification.RemoraNotificationManager
import io.github.lottooss.remora.notification.channelForKind
import io.github.lottooss.remora.notification.deepLinkForPayload
import io.github.lottooss.remora.notification.parsePushPayload
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class RemoraMessagingService : FirebaseMessagingService() {

    @Inject lateinit var keyStorage: KeyStorage
    @Inject lateinit var hostRepository: HostRepository
    @Inject lateinit var pushTokenRegistrar: PushTokenRegistrar

    private val notificationManager by lazy { RemoraNotificationManager(this) }
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        if (data["v"] != "1") return

        if (data["k"] == "host_offline") {
            handleHostOffline(data["h"].orEmpty())
            return
        }

        val ct = data["ct"]
        if (ct != null) {
            serviceScope.launch {
                handleEncryptedPayload(data["h"].orEmpty(), ct)
            }
        }
    }

    override fun onNewToken(token: String) {
        pushTokenRegistrar.updateToken(token)
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun handleHostOffline(hostId: String) {
        val host = hostRepository.hosts.value.find { it.id.value == hostId } ?: return
        if (!pushTokenRegistrar.preference(hostId)) return
        val hostName = host.name
        notificationManager.showNotification(
            channel = RemoraNotificationChannel.HOST_OFFLINE,
            title = getString(R.string.notification_host_offline),
            body = getString(R.string.notification_host_offline_body, hostName),
            deepLink = "remora://hosts",
            notificationId = hostId.hashCode(),
        )
    }

    private suspend fun handleEncryptedPayload(hostId: String, ct: String) {
        if (hostRepository.hosts.value.none { it.id.value == hostId } || ct.length > 3_072) return
        val keys = keyStorage.getHostKeys(hostId) ?: return
        val plaintext = try {
            openPushPayload(keys.pushKey, decodeBase64Url(ct), PushContext(hostId, keys.deviceId))
        } catch (_: Exception) { return }
        finally { keys.wipe() }
        if (plaintext.toByteArray().size > 2_048) return

        val payload = parsePushPayload(plaintext) ?: return
        val channel = channelForKind(payload.kind)
        val deepLink = deepLinkForPayload(payload, hostId)

        notificationManager.showNotification(
            channel = channel,
            title = payload.title,
            body = payload.body,
            deepLink = deepLink,
            notificationId = (hostId + ":" + (payload.pendingId ?: payload.sessionId ?: payload.kind.name)).hashCode(),
        )
    }

}
