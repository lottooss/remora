package io.github.lottooss.remora

import android.content.Context
import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import io.github.lottooss.remora.core.crypto.Keypair
import io.github.lottooss.remora.core.crypto.encodeBase64Url
import io.github.lottooss.remora.core.data.*
import io.github.lottooss.remora.core.model.Host
import io.github.lottooss.remora.core.model.HostId
import io.github.lottooss.remora.core.security.ApprovalKeyManager
import io.github.lottooss.remora.core.security.KeyStorage
import io.github.lottooss.remora.core.security.AuthenticationException
import io.github.lottooss.remora.core.security.AuthenticationFailure
import io.github.lottooss.remora.core.transport.ConnectionManager
import io.github.lottooss.remora.core.transport.ConnectionState
import io.github.lottooss.remora.core.transport.HostConnectionInfo
import io.github.lottooss.remora.core.transport.RcpClient
import io.github.lottooss.remora.di.ForegroundConnections
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import javax.inject.Inject
import java.util.UUID

/** Owns foreground connections and keeps every repository and callback bound to its host. */
@HiltViewModel
class RemoraViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    val hostRepository: HostRepository,
    private val keys: KeyStorage,
    private val registrar: PushTokenRegistrar,
    private val foregroundConnections: ForegroundConnections,
) : ViewModel() {
    private val approvalKeys = ApprovalKeyManager(context)
    private val pairing = PairingService(hostRepository, keys, approvalKeys)
    val pairingState = pairing.pairingState
    val hosts = hostRepository.hosts
    val activeHost = hostRepository.activeHost
    private val _runtimes = MutableStateFlow<Map<String, HostRuntime>>(emptyMap())
    val runtimes = _runtimes.asStateFlow()
    private val _notices = MutableSharedFlow<Int>(extraBufferCapacity = 8)
    val notices = _notices.asSharedFlow()
    private val _connectionStates = MutableStateFlow<Map<String, ConnectionState>>(emptyMap())
    val connectionStates = _connectionStates.asStateFlow()
    val diagnostics = DiagnosticsRepository()
    private val settingsService = SettingsService()
    private val rotationPreferences = context.getSharedPreferences("remora_rotation_requests", Context.MODE_PRIVATE)
    private var backgroundJob: Job? = null
    private var pairingJob: Job? = null
    private var connectionsAllowed = false

    init {
        viewModelScope.launch {
            hosts.collect { paired ->
                val ids = paired.map { it.id.value }.toSet()
                val current = _runtimes.value.toMutableMap()
                current.keys.filter { it !in ids }.forEach { id -> current.remove(id)?.close() }
                paired.forEach { host ->
                    if (host.id.value !in current) {
                        current[host.id.value] = HostRuntime(
                            host, viewModelScope,
                            isSelected = { activeHost.value?.id == host.id },
                            onPresence = { peer ->
                                viewModelScope.launch {
                                    val currentHost = hosts.value.firstOrNull { it.id == host.id }
                                    if (peer.id == host.id.value && currentHost != null) {
                                        hostRepository.updateHost(currentHost.copy(isOnline = peer.online,
                                            lastSeenAt = peer.lastSeenAt ?: if (peer.online) System.currentTimeMillis() else currentHost.lastSeenAt))
                                    }
                                }
                            },
                            onConnectionState = { state ->
                                _connectionStates.update { it + (host.id.value to state) }
                                diagnostics.record(host.id.value, DiagnosticsRepository.Event.valueOf(state.name.uppercase()))
                                if (state == ConnectionState.Idle || state == ConnectionState.Backoff) {
                                    viewModelScope.launch {
                                        hosts.value.firstOrNull { it.id == host.id && it.isOnline }?.let {
                                            hostRepository.updateHost(it.copy(isOnline = false))
                                        }
                                    }
                                }
                                if (state == ConnectionState.Ready && BuildConfig.HAS_GOOGLE_SERVICES) {
                                    viewModelScope.launch {
                                        val relay = _runtimes.value[host.id.value]?.connection?.relayClient?.value
                                        if (relay != null) try { registrar.registerWithRelay(host.id.value, relay) }
                                        catch (cancelled: CancellationException) { throw cancelled }
                                        catch (_: Exception) { diagnostics.record(host.id.value, DiagnosticsRepository.Event.TOKEN_PENDING) }
                                    }
                                }
                            },
                        )
                    }
                }
                _runtimes.value = current
                foregroundConnections.replace(current.mapValues { it.value.connection })
                _connectionStates.update { it.filterKeys(ids::contains) }
                if (connectionsAllowed && pairingJob == null) current.values.forEach(::connect)
            }
        }
    }

    /** Thirty-second foreground grace avoids reconnecting while changing Android activities. */
    fun setForeground(value: Boolean) {
        backgroundJob?.cancel()
        if (value) {
            connectionsAllowed = true
            foregroundConnections.hasLease = true
            if (pairingJob == null) {
                _runtimes.value.values.forEach(::connect)
                if (BuildConfig.HAS_GOOGLE_SERVICES) registrar.start()
            }
        } else {
            registrar.stop()
            backgroundJob = viewModelScope.launch {
                delay(30_000)
                connectionsAllowed = false
                pairingJob?.cancel()
                _runtimes.value.values.forEach { it.disconnect() }
                foregroundConnections.hasLease = false
            }
        }
    }

    private fun connect(runtime: HostRuntime) {
        if (runtime.connectJob?.isActive == true || runtime.connection.activeHostId.value != null) return
        runtime.connectJob = viewModelScope.launch {
            try {
                val material = withContext(Dispatchers.IO) { keys.getHostKeys(runtime.host.id.value) }
                    ?: throw IllegalStateException("Pairing keys unavailable")
                runtime.pairedDeviceId = material.deviceId
                try {
                    if (connectionsAllowed && _runtimes.value[runtime.host.id.value] === runtime) {
                        runtime.connection.connect(HostConnectionInfo(
                            hostId = runtime.host.id.value,
                            hostNoisePub = runtime.host.hostNoisePub,
                            relayOrigin = runtime.host.relayOrigin,
                            deviceId = material.deviceId,
                            relayPrivateKey = material.relayPrivKey,
                            noiseKeypair = Keypair(material.noisePrivKey, material.noisePubKey),
                            devicePsk = material.devicePsk,
                        ))
                    }
                } finally { material.wipe() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                _notices.emit(R.string.connection_unavailable)
            }
        }
    }

    fun pair(qr: String) {
        if (pairingJob != null) return
        foregroundConnections.hasLease = true
        registrar.stop()
        pairingJob = viewModelScope.launch {
            try { withContext(Dispatchers.IO) {
                val name = Build.MODEL.filter { !it.isISOControl() }.trim().take(40).ifBlank { "Android" }
                pairing.startPairing(qr, name)
            } }
            finally {
                pairingJob = null
                if (connectionsAllowed) {
                    _runtimes.value.values.forEach(::connect)
                    if (BuildConfig.HAS_GOOGLE_SERVICES) registrar.start()
                } else foregroundConnections.hasLease = false
            }
        }
    }

    fun resetPairing() {
        pairingJob?.cancel()
        pairing.reset()
    }

    fun selectHost(id: String) {
        val host = hosts.value.firstOrNull { it.id.value == id } ?: return
        viewModelScope.launch { hostRepository.setActiveHost(host.id) }
    }

    fun unpair(id: String) {
        val host = hosts.value.firstOrNull { it.id.value == id } ?: return
        viewModelScope.launch {
            try {
                val client = _runtimes.value[id]?.connection?.rcpClient?.value ?: error("Host disconnected")
                // If online, revoke on the host before forgetting the local pairing.
                settingsService.unpair(client).getOrThrow()
                _runtimes.value[id]?.disconnect()
                withContext(Dispatchers.IO) { hostRepository.removeHost(host.id) }
                rotationPreferences.edit().remove("request_$id").remove("accepted_$id").apply()
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { _notices.emit(R.string.operation_failed) }
        }
    }

    fun updatePushToken(token: String) { registrar.updateToken(token) }
    fun hostOfflineNotifications(id: String): Boolean = registrar.preference(id)
    fun setHostOfflineNotifications(id: String, enabled: Boolean) { registrar.setHostOffline(id, enabled) }

    /** A stale screen may never send to a newly selected or removed host. */
    private fun selected(runtime: HostRuntime): RcpClient {
        check(activeHost.value?.id == runtime.host.id && _runtimes.value[runtime.host.id.value] === runtime)
        return runtime.connection.rcpClient.value ?: error("Host disconnected")
    }

    private fun action(runtime: HostRuntime, block: suspend (RcpClient) -> Unit) {
        viewModelScope.launch {
            try { block(selected(runtime)) }
            catch (_: TimeoutCancellationException) { _notices.emit(R.string.operation_failed) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: AuthenticationException) {
                if (error.reason == AuthenticationFailure.KEY_INVALIDATED) {
                    rotateApprovalKey(runtime)
                    _notices.emit(R.string.approval_key_needs_rotation)
                } else _notices.emit(R.string.operation_failed)
            }
            catch (_: Exception) { _notices.emit(R.string.operation_failed) }
        }
    }

    fun refresh(runtime: HostRuntime) = action(runtime) { runtime.sessionsService.listSessions(it).getOrThrow() }
    suspend fun send(runtime: HostRuntime, sessionId: String, text: String, delivery: String): Boolean = try {
        val accepted = runtime.sessionsService.sendPrompt(selected(runtime), sessionId, text, delivery).getOrThrow()
        if (!accepted) _notices.emit(R.string.operation_failed)
        accepted
    } catch (_: TimeoutCancellationException) { _notices.emit(R.string.operation_failed); false }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { _notices.emit(R.string.operation_failed); false }
    fun cancel(runtime: HostRuntime, sessionId: String) = action(runtime) {
        runtime.sessionsService.cancelTurn(it, sessionId).getOrThrow()
    }
    fun loadOlder(runtime: HostRuntime, sessionId: String) = action(runtime) {
        runtime.sessionsService.loadOlderEvents(it, sessionId).getOrThrow()
    }
    fun selectModel(runtime: HostRuntime, sessionId: String, model: ModelRef) = action(runtime) {
        val actual = runtime.sessionsService.selectModel(it, sessionId, model).getOrThrow()
        runtime.sessions.getSession(sessionId)?.let { session ->
            runtime.sessions.upsertSession(session.copy(model = actual))
        }
    }

    fun answerApproval(
        runtime: HostRuntime, approval: PendingApproval, outcome: String,
        signer: suspend (String, ByteArray) -> ByteArray,
    ) = action(runtime) { client ->
        val result = runtime.interactionsService.answerApproval(
            hostId = runtime.host.id.value, approval = approval, outcome = outcome,
            displayedPreview = approval.preview, rcpClient = client,
            signatureProvider = { message ->
                val signature = signer(runtime.host.id.value, message.toByteArray(Charsets.UTF_8))
                try {
                    check(selected(runtime) === client)
                    encodeBase64Url(signature)
                } finally { signature.fill(0) }
            },
            rpcCaller = { method, params ->
                check(selected(runtime) === client)
                client.call(method, params) as JsonObject
            },
        ).getOrThrow()
        if (!result.accepted) _notices.emit(R.string.interaction_already_resolved)
    }

    fun answerQuestion(runtime: HostRuntime, question: PendingQuestion, answers: List<QuestionAnswer>) = action(runtime) {
        check(runtime.interactionsService.answerQuestion(
            hostId = runtime.host.id.value, question = question, answers = answers, rcpClient = it,
        ).getOrThrow())
    }

    fun refreshSettings(runtime: HostRuntime) = action(runtime) { client ->
        runtime.settings.value = runtime.settings.value.copy(loading = true, errorCode = null)
        try {
            runtime.settings.value = SettingsUiState(
                device = settingsService.self(client).getOrThrow(),
                preferences = settingsService.getPreferences(client).getOrThrow(),
                connected = true,
                rotationPending = rotationPreferences.getBoolean("accepted_${runtime.host.id.value}", false),
            )
        } catch (error: Exception) {
            runtime.settings.value = runtime.settings.value.copy(loading = false, errorCode = "request_failed")
            throw error
        }
    }

    fun setPreferences(runtime: HostRuntime, preferences: NotifyPreferences) {
        if (runtime.settings.value.loading) return
        action(runtime) { client ->
            runtime.settings.value = runtime.settings.value.copy(loading = true)
            try {
                val actual = settingsService.setPreferences(client, preferences).getOrThrow()
                runtime.settings.value = runtime.settings.value.copy(preferences = actual)
            } finally { runtime.settings.value = runtime.settings.value.copy(loading = false) }
        }
    }

    /** Retains the old signing key while the replacement awaits confirmation on the PC. */
    fun rotateApprovalKey(runtime: HostRuntime) = action(runtime) { client ->
        val hostId = runtime.host.id.value
        val pending = withContext(Dispatchers.IO) { approvalKeys.createPendingApprovalKey(hostId) }
        val requestId = rotationPreferences.getString("request_$hostId", null) ?: UUID.randomUUID().toString().also {
            check(rotationPreferences.edit().putString("request_$hostId", it).commit())
        }
        check(runtime.interactionsService.rotateApprovalKeyOnHost(
            hostId = hostId, newPublicKeySpkiDer = pending.publicKeySpkiDer,
            requestId = requestId, rcpClient = client,
            rpcCaller = { method, params ->
                check(selected(runtime) === client)
                client.call(method, params) as JsonObject
            },
        ).getOrThrow())
        check(rotationPreferences.edit().putBoolean("accepted_$hostId", true).commit())
        runtime.settings.value = runtime.settings.value.copy(rotationPending = true)
    }

    /** Explicit user acknowledgement follows the separate, required PC confirmation. */
    fun activatePendingApprovalKey(runtime: HostRuntime) = action(runtime) {
        val hostId = runtime.host.id.value
        check(rotationPreferences.getBoolean("accepted_$hostId", false))
        withContext(Dispatchers.IO) {
            val pending = approvalKeys.pendingApprovalKey(hostId) ?: error("No pending approval key")
            val material = keys.getHostKeys(hostId) ?: error("Pairing keys unavailable")
            try {
                keys.saveHostKeys(hostId, material.copy(approvalPubSpki = pending.publicKeySpkiDer))
                approvalKeys.activatePendingApprovalKey(hostId, pending.publicKeySpkiDer)
            } finally { material.wipe() }
        }
        check(rotationPreferences.edit().remove("request_$hostId").remove("accepted_$hostId").commit())
        runtime.settings.value = runtime.settings.value.copy(rotationPending = false)
    }

    override fun onCleared() {
        registrar.stop()
        foregroundConnections.replace(emptyMap())
        foregroundConnections.hasLease = false
        _runtimes.value.values.forEach { it.close() }
        super.onCleared()
    }
}

/** Connection-scoped services never consult the currently selected host implicitly. */
class HostRuntime(
    val host: Host,
    parent: CoroutineScope,
    private val isSelected: () -> Boolean,
    onPresence: (io.github.lottooss.remora.core.transport.RelayPeer) -> Unit,
    onConnectionState: (ConnectionState) -> Unit,
) {
    private val scope = CoroutineScope(parent.coroutineContext + SupervisorJob(parent.coroutineContext[Job]))
    val connection = ConnectionManager(scope, BuildConfig.VERSION_NAME)
    val sessions = SessionRepository()
    val interactions = InteractionRepository()
    val workspaces = WorkspaceRepository()
    val sync = SyncEngine(sessions, scope, interactions, workspaces)
    val sessionsService = SessionService(sessions)
    private var hostClockOffset = 0L
    /** Paired device identity loaded with the keys in [connect]; null while unpaired. */
    @Volatile
    var pairedDeviceId: String? = null
    val interactionsService = InteractionService(interactions, host.id.value, {
        // Crypto/1 §7: answers sign the paired device identity, taken from the
        // stored pairing material — never from request-supplied values.
        pairedDeviceId ?: error("Host disconnected")
    }) {
        System.currentTimeMillis() + hostClockOffset
    }
    val models = MutableStateFlow<List<ModelRef>>(emptyList())
    val settings = MutableStateFlow(SettingsUiState())
    val filesService = FilesService(rpcCaller = { method, params -> requireClient().call(method, params) })
    val workspaceService = WorkspaceService(rpcCaller = { method, params -> requireClient().call(method, params) })
    var connectJob: Job? = null

    init {
        sync.bind(connection.rcpClient)
        scope.launch { connection.presence.collect(onPresence) }
        scope.launch {
            connection.connectionState.collect { state ->
                onConnectionState(state)
                settings.value = settings.value.copy(connected = state == ConnectionState.Ready)
            }
        }
        scope.launch {
            connection.hello.collect { hello ->
                hello?.get("time")?.jsonPrimitive?.longOrNull?.let {
                    hostClockOffset = it - System.currentTimeMillis()
                }
            }
        }
        scope.launch {
            connection.rcpClient.collectLatest { client ->
                if (client != null) {
                    sessionsService.listSessions(client)
                    sessionsService.loadModelsCatalog(client).onSuccess { models.value = it }
                }
            }
        }
        scope.launch {
            sessions.controlStates.map { states -> states.mapValues { it.value.running } }
                .distinctUntilChanged().collectLatest {
                    delay(300)
                    connection.rcpClient.value?.let { sessionsService.listSessions(it) }
                }
        }
    }

    fun requireClient(): RcpClient {
        check(isSelected())
        return connection.rcpClient.value ?: error("Host disconnected")
    }
    fun disconnect() {
        connectJob?.cancel()
        connection.disconnect()
        pairedDeviceId = null
    }
    fun close() {
        disconnect()
        sync.closeAll()
        sessions.clear()
        interactions.clear()
        workspaces.clear()
        scope.cancel()
    }
}
