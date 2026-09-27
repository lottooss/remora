package io.github.lottooss.remora.notification

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import io.github.lottooss.remora.MainActivity

class RemoraNotificationManager(private val context: Context) {

    init {
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            listOf(
                ChannelSpec(CHANNEL_APPROVALS, "Approvals", NotificationManager.IMPORTANCE_HIGH, "High-priority approvals"),
                ChannelSpec(CHANNEL_QUESTIONS, "Questions", NotificationManager.IMPORTANCE_HIGH, "High-priority questions"),
                ChannelSpec(CHANNEL_TURNS, "Turn Events", NotificationManager.IMPORTANCE_DEFAULT, "Turn completion events"),
                ChannelSpec(CHANNEL_ERRORS, "Errors", NotificationManager.IMPORTANCE_HIGH, "High-priority errors"),
                ChannelSpec(CHANNEL_HOST_OFFLINE, "Host Offline", NotificationManager.IMPORTANCE_HIGH, "High-priority host offline alerts"),
            ).forEach { spec ->
                manager.createNotificationChannel(
                    NotificationChannel(spec.id, spec.name, spec.importance).apply {
                        description = spec.description
                    }
                )
            }
        }
    }

    fun showNotification(
        channel: RemoraNotificationChannel,
        title: String,
        body: String,
        deepLink: String,
        notificationId: Int,
    ) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(deepLink)).apply {
            setPackage(context.packageName)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, channelIdFor(channel))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(notificationId, notification)
    }

    private fun channelIdFor(channel: RemoraNotificationChannel): String = when (channel) {
        RemoraNotificationChannel.APPROVALS -> CHANNEL_APPROVALS
        RemoraNotificationChannel.QUESTIONS -> CHANNEL_QUESTIONS
        RemoraNotificationChannel.TURNS -> CHANNEL_TURNS
        RemoraNotificationChannel.ERRORS -> CHANNEL_ERRORS
        RemoraNotificationChannel.HOST_OFFLINE -> CHANNEL_HOST_OFFLINE
    }

    private data class ChannelSpec(
        val id: String,
        val name: String,
        val importance: Int,
        val description: String = "",
    )

    companion object {
        const val CHANNEL_APPROVALS = "remora_approvals"
        const val CHANNEL_QUESTIONS = "remora_questions"
        const val CHANNEL_TURNS = "remora_turns"
        const val CHANNEL_ERRORS = "remora_errors"
        const val CHANNEL_HOST_OFFLINE = "remora_host_offline"
    }
}
