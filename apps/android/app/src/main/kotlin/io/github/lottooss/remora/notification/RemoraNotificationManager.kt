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
import io.github.lottooss.remora.R
import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat

class RemoraNotificationManager(private val context: Context) {

    init {
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            listOf(
                ChannelSpec(CHANNEL_APPROVALS, context.getString(R.string.notification_approvals), NotificationManager.IMPORTANCE_HIGH),
                ChannelSpec(CHANNEL_QUESTIONS, context.getString(R.string.notification_questions), NotificationManager.IMPORTANCE_HIGH),
                ChannelSpec(CHANNEL_TURNS, context.getString(R.string.notification_turns), NotificationManager.IMPORTANCE_DEFAULT),
                ChannelSpec(CHANNEL_ERRORS, context.getString(R.string.notification_errors), NotificationManager.IMPORTANCE_DEFAULT),
                ChannelSpec(CHANNEL_HOST_OFFLINE, context.getString(R.string.notification_host_offline), NotificationManager.IMPORTANCE_LOW),
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
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(deepLink)
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
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
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
