package io.github.lottooss.remora

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import io.github.lottooss.remora.core.transport.ConnectionState
import io.github.lottooss.remora.core.ui.ConnectionStatus
import io.github.lottooss.remora.feature.conversation.ApprovalsScreen
import io.github.lottooss.remora.feature.conversation.ConversationScreen
import io.github.lottooss.remora.feature.files.FilesScreen
import io.github.lottooss.remora.feature.pairing.PairingScreen
import io.github.lottooss.remora.feature.sessions.HostsScreen
import io.github.lottooss.remora.feature.sessions.SessionsScreen
import io.github.lottooss.remora.feature.settings.DiagnosticsScreen
import io.github.lottooss.remora.feature.settings.SettingsScreen
import io.github.lottooss.remora.feature.workspace.WorkspaceScreen
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

/** Every feature receives services bound to the host named by its navigation entry. */
@Composable
fun RemoraNavHost(
    navController: NavHostController,
    model: RemoraViewModel,
    approvalSigner: suspend (String, ByteArray) -> ByteArray,
    modifier: Modifier = Modifier,
) {
    val hosts by model.hosts.collectAsStateWithLifecycle()
    val activeHost by model.activeHost.collectAsStateWithLifecycle()
    val runtimes by model.runtimes.collectAsStateWithLifecycle()
    val states by model.connectionStates.collectAsStateWithLifecycle()
    val initialRoute = remember { if (hosts.isEmpty()) Routes.PAIR else Routes.HOSTS }
    val snackbar = remember { SnackbarHostState() }
    val context = LocalContext.current
    LaunchedEffect(model) { model.notices.collect { snackbar.showSnackbar(context.getString(it)) } }
    val back: () -> Unit = { navController.popBackStack() }
    val chooseHost: () -> Unit = { navController.navigate(Routes.HOSTS) { launchSingleTop = true } }

    Box(modifier.fillMaxSize()) {
        NavHost(navController, startDestination = initialRoute) {
            composable(Routes.PAIR) {
                val state by model.pairingState.collectAsStateWithLifecycle()
                PairingScreen(
                    state = state, onQrSubmit = model::pair, onReset = model::resetPairing,
                    onBack = if (hosts.isEmpty()) null else back,
                    onPaired = {
                        model.resetPairing()
                        navController.navigate(Routes.HOSTS) { popUpTo(Routes.PAIR) { inclusive = true } }
                    },
                )
            }
            composable(Routes.HOSTS, deepLinks = listOf(navDeepLink { uriPattern = "remora://hosts" })) {
                HostsScreen(
                    hosts = hosts.map { it.copy(isOnline = states[it.id.value] == ConnectionState.Ready) },
                    activeHostId = activeHost?.id?.value,
                    onOpenSessions = { id -> model.selectHost(id); navController.navigate(Routes.SESSIONS) },
                    onPair = { model.resetPairing(); navController.navigate(Routes.PAIR) }, onUnpair = model::unpair,
                )
            }
            composable(Routes.SESSIONS) {
                WithHost(runtimes[activeHost?.id?.value], chooseHost) { runtime ->
                    val state by runtime.connection.connectionState.collectAsStateWithLifecycle()
                    SessionsScreen(
                        sessionRepository = runtime.sessions, connectionStatus = state.uiStatus(),
                        onRefresh = { model.refresh(runtime) }, onBack = chooseHost,
                        onOpenConversation = { navController.navigate(Routes.conversation(runtime.host.id.value, it)) },
                        onNewSession = { navController.navigate(Routes.newSession(runtime.host.id.value)) },
                        onOpenApprovals = { navController.navigate(Routes.APPROVALS) },
                    )
                }
            }
            composable(
                Routes.CONVERSATION, arguments = hostSessionArguments(),
                deepLinks = listOf(navDeepLink { uriPattern = "remora://host/{hostId}/session/{sessionId}" }),
            ) { entry ->
                val hostId = entry.arguments?.getString(Routes.HOST_ID_ARG).orEmpty()
                val sessionId = entry.arguments?.getString(Routes.SESSION_ID_ARG).orEmpty()
                LaunchedEffect(hostId) { model.selectHost(hostId) }
                WithHost(runtimes[hostId], chooseHost) { runtime ->
                    val state by runtime.connection.connectionState.collectAsStateWithLifecycle()
                    val models by runtime.models.collectAsStateWithLifecycle()
                    val sessions by runtime.sessions.sessions.collectAsStateWithLifecycle()
                    DisposableEffect(runtime, sessionId) {
                        runtime.sync.watchSession(sessionId)
                        onDispose { runtime.sync.unwatchSession(sessionId) }
                    }
                    ConversationScreen(
                        sessionId = sessionId, onBack = back,
                        onOpenFiles = { navController.navigate(Routes.files(hostId, it)) },
                        sessionRepository = runtime.sessions, syncEngine = runtime.sync,
                        interactionRepository = runtime.interactions,
                        connectionStatus = state.uiStatus(), availableModels = models,
                        selectedModel = sessions.firstOrNull { it.id == sessionId }?.model,
                        onSelectModel = { model.selectModel(runtime, sessionId, it) },
                        onSendPrompt = { text, delivery -> model.send(runtime, sessionId, text, delivery) },
                        onCancelTurn = { model.cancel(runtime, sessionId) }, onLoadOlder = { model.loadOlder(runtime, sessionId) },
                        onApprove = { model.answerApproval(runtime, it, "allowed-once", approvalSigner) },
                        onReject = { model.answerApproval(runtime, it, "rejected", approvalSigner) },
                        onSubmitQuestion = { question, answers -> model.answerQuestion(runtime, question, answers) },
                    )
                }
            }
            composable(Routes.NEW_SESSION, arguments = listOf(navArgument(Routes.HOST_ID_ARG) { type = NavType.StringType })) { entry ->
                val hostId = entry.arguments?.getString(Routes.HOST_ID_ARG).orEmpty()
                LaunchedEffect(hostId) { model.selectHost(hostId) }
                WithHost(runtimes[hostId], chooseHost) { runtime ->
                    val client by runtime.connection.rcpClient.collectAsStateWithLifecycle()
                    val hello by runtime.connection.hello.collectAsStateWithLifecycle()
                    val workspaces by runtime.workspaces.workspaces.collectAsStateWithLifecycle()
                    val models by runtime.models.collectAsStateWithLifecycle()
                    val policy = hello?.get("policy") as? JsonObject
                    key(client) {
                        WorkspaceScreen(
                            workspaceService = runtime.workspaceService, onBack = back,
                            initialWorkspaces = workspaces, availableModels = models,
                            initialRoots = hello?.get("roots")?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty(),
                            allowRemoteSessionStart = client != null && policy?.get("allowRemoteSessionStart")?.jsonPrimitive?.booleanOrNull == true,
                            onSessionCreated = { id ->
                                navController.navigate(Routes.conversation(hostId, id)) { popUpTo(Routes.NEW_SESSION) { inclusive = true } }
                            },
                        )
                    }
                }
            }
            composable(Routes.FILES, arguments = hostSessionArguments()) { entry ->
                val hostId = entry.arguments?.getString(Routes.HOST_ID_ARG).orEmpty()
                LaunchedEffect(hostId) { model.selectHost(hostId) }
                val sessionId = entry.arguments?.getString(Routes.SESSION_ID_ARG).orEmpty()
                WithHost(runtimes[hostId], chooseHost) { runtime ->
                    val client by runtime.connection.rcpClient.collectAsStateWithLifecycle()
                    key(client) { FilesScreen(sessionId, onBack = back, filesService = runtime.filesService) }
                }
            }
            composable(Routes.APPROVALS) { ApprovalInbox(runtimes[activeHost?.id?.value], model, approvalSigner, chooseHost, back) }
            composable(
                Routes.HOST_APPROVALS,
                arguments = listOf(navArgument(Routes.HOST_ID_ARG) { type = NavType.StringType }),
                deepLinks = listOf(navDeepLink { uriPattern = "remora://host/{hostId}/approvals" }),
            ) { entry ->
                val hostId = entry.arguments?.getString(Routes.HOST_ID_ARG).orEmpty()
                LaunchedEffect(hostId) { model.selectHost(hostId) }
                ApprovalInbox(runtimes[hostId], model, approvalSigner, chooseHost, back)
            }
            composable(Routes.SETTINGS) {
                WithHost(runtimes[activeHost?.id?.value], chooseHost) { runtime ->
                    val client by runtime.connection.rcpClient.collectAsStateWithLifecycle()
                    val settings by runtime.settings.collectAsStateWithLifecycle()
                    var offlineNotifications by remember(runtime) { mutableStateOf(model.hostOfflineNotifications(runtime.host.id.value)) }
                    LaunchedEffect(runtime, client) { if (client != null) model.refreshSettings(runtime) }
                    SettingsScreen(
                        state = settings, isPushConfigured = BuildConfig.HAS_GOOGLE_SERVICES, onBack = back,
                        onOpenDiagnostics = { navController.navigate(Routes.DIAGNOSTICS) },
                        onNotificationsChanged = { model.setPreferences(runtime, it) }, hostOffline = offlineNotifications,
                        onHostOfflineChanged = { enabled ->
                            model.setHostOfflineNotifications(runtime.host.id.value, enabled); offlineNotifications = enabled
                        },
                        onRotateApprovalKey = { model.rotateApprovalKey(runtime) },
                        onActivatePendingApprovalKey = { model.activatePendingApprovalKey(runtime) },
                        onUnpair = { model.unpair(runtime.host.id.value) },
                        onToggleFlagSecure = null, onToggleAppLock = null,
                    )
                }
            }
            composable(Routes.DIAGNOSTICS) {
                val entries by model.diagnostics.lines.collectAsStateWithLifecycle()
                val greeting = runtimes[activeHost?.id?.value]?.connection?.hello?.value
                val versions = (greeting?.get("host") as? JsonObject)?.get("versions") as? JsonObject
                val report = remember(entries, versions) { model.diagnostics.report(BuildConfig.VERSION_NAME,
                    versions?.get("remora")?.jsonPrimitive?.content, versions?.get("dsh")?.jsonPrimitive?.content) }
                DiagnosticsScreen(report = report, onBack = back)
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(16.dp))
    }
}

@Composable
private fun WithHost(runtime: HostRuntime?, onChoose: () -> Unit, content: @Composable (HostRuntime) -> Unit) {
    if (runtime == null) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.choose_host))
            Button(onClick = onChoose) { Text(stringResource(R.string.open_hosts)) }
        }
    } else key(runtime.host.id.value) { content(runtime) }
}

@Composable
private fun ApprovalInbox(runtime: HostRuntime?, model: RemoraViewModel, signer: suspend (String, ByteArray) -> ByteArray, onChoose: () -> Unit, onBack: () -> Unit) =
    WithHost(runtime, onChoose) { host ->
        ApprovalsScreen(
            interactionRepository = host.interactions, onBack = onBack,
            onApprove = { model.answerApproval(host, it, "allowed-once", signer) },
            onReject = { model.answerApproval(host, it, "rejected", signer) },
        )
    }

private fun hostSessionArguments() = listOf(
    navArgument(Routes.HOST_ID_ARG) { type = NavType.StringType },
    navArgument(Routes.SESSION_ID_ARG) { type = NavType.StringType },
)

private fun ConnectionState.uiStatus(): ConnectionStatus = when (this) {
    ConnectionState.Ready -> ConnectionStatus.ONLINE
    ConnectionState.Backoff -> ConnectionStatus.ERROR
    else -> ConnectionStatus.OFFLINE
}
