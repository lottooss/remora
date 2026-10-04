package io.github.lottooss.remora.core.data

import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.transport.RcpClient
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import java.util.UUID

data class NotifyPreferences(
    val approval: Boolean = true,
    val question: Boolean = true,
    val turnDone: Boolean = true,
    val turnError: Boolean = true,
)

data class DeviceSelf(val id: String, val name: String, val pairedAt: Long, val hardwareBacked: Boolean?)

data class SettingsUiState(
    val loading: Boolean = false,
    val device: DeviceSelf? = null,
    val preferences: NotifyPreferences? = null,
    val rotationPending: Boolean = false,
    val errorCode: String? = null,
    val connected: Boolean = false,
)

/** Host-authoritative notification preferences and self-device operations. */
class SettingsService {
    suspend fun getPreferences(client: RcpClient?): Result<NotifyPreferences> = result {
        parsePreferences(requireClient(client).call("notify.prefs.get").jsonObject)
    }
    suspend fun setPreferences(client: RcpClient?, preferences: NotifyPreferences): Result<NotifyPreferences> = result {
        parsePreferences(requireClient(client).call("notify.prefs.set", buildJsonObject {
            put("approval", preferences.approval); put("question", preferences.question)
            put("turnDone", preferences.turnDone); put("turnError", preferences.turnError)
        }).jsonObject)
    }
    suspend fun self(client: RcpClient?): Result<DeviceSelf> = result {
        val obj = requireClient(client).call("devices.self").jsonObject
        DeviceSelf(obj.getValue("id").jsonPrimitive.content, obj.getValue("name").jsonPrimitive.content,
            obj.getValue("pairedAt").jsonPrimitive.long,
            obj.getValue("approvalKey").jsonObject["hardwareBacked"]?.jsonPrimitive?.booleanOrNull)
    }
    suspend fun unpair(client: RcpClient?, requestId: String = UUID.randomUUID().toString()): Result<Unit> = result {
        val obj = requireClient(client).call("devices.unpair", buildJsonObject { put("requestId", requestId) }).jsonObject
        check(obj["ok"]?.jsonPrimitive?.booleanOrNull == true) { "Unpair not acknowledged" }
    }
    suspend fun rotateApprovalKey(client: RcpClient?, publicKeySpki: ByteArray,
        requestId: String = UUID.randomUUID().toString()): Result<Unit> = result {
        val obj = requireClient(client).call("devices.rotateApprovalKey", buildJsonObject {
            put("approvalPub", encodeBase64Url(publicKeySpki)); put("requestId", requestId)
        }).jsonObject
        check(obj["status"]?.jsonPrimitive?.content == "pending_pc_confirmation") { "Rotation not acknowledged" }
    }
    private fun parsePreferences(obj: JsonObject) = NotifyPreferences(
        obj.getValue("approval").jsonPrimitive.boolean, obj.getValue("question").jsonPrimitive.boolean,
        obj.getValue("turnDone").jsonPrimitive.boolean, obj.getValue("turnError").jsonPrimitive.boolean,
    )
    private fun requireClient(client: RcpClient?) = client ?: error("Host disconnected")
    private suspend fun <T> result(block: suspend () -> T): Result<T> = try { Result.success(block()) }
        catch (timeout: kotlinx.coroutines.TimeoutCancellationException) { Result.failure(timeout) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) { Result.failure(error) }
}
