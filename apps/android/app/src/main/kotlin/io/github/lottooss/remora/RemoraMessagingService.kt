package io.github.lottooss.remora

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dagger.hilt.android.AndroidEntryPoint
import io.github.lottooss.remora.core.crypto.decodeBase64Url
import io.github.lottooss.remora.core.crypto.openPushPayload
import io.github.lottooss.remora.core.data.HostRepository
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

    private val notificationManager by lazy { RemoraNotificationManager(this) }
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data

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
        // TODO: send token to relay via PushTokenRequest
    }

    override fun onDestroy() {
        serviceScope.cancel()
        super.onDestroy()
    }

    private fun handleHostOffline(hostId: String) {
        val host = hostRepository.hosts.value.find { it.id.value == hostId }
        val hostName = host?.name ?: "Unknown Host"
        notificationManager.showNotification(
            channel = RemoraNotificationChannel.HOST_OFFLINE,
            title = "Host Offline",
            body = "$hostName is offline",
            deepLink = "remora://hosts",
            notificationId = NOTIFICATION_ID_HOST_OFFLINE,
        )
    }

    private suspend fun handleEncryptedPayload(hostId: String, ct: String) {
        val keys = keyStorage.getHostKeys(hostId) ?: return
        val pushKey = keys.pushKey
        keys.wipe()

        val plaintext = try {
            openPushPayload(pushKey, decodeBase64Url(ct))
        } catch (_: Exception) {
            return
        }

        val payload = parsePushPayload(plaintext) ?: return
        val channel = channelForKind(payload.kind)
        val deepLink = deepLinkForPayload(payload)

        notificationManager.showNotification(
            channel = channel,
            title = payload.title,
            body = payload.body,
            deepLink = deepLink,
            notificationId = payload.sessionId?.hashCode() ?: payload.title.hashCode(),
        )
    }

    companion object {
        private const val NOTIFICATION_ID_HOST_OFFLINE = 1001
    }
}
