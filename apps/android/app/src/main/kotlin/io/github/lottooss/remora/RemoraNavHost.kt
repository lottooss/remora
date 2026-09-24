package io.github.lottooss.remora

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.navArgument
import io.github.lottooss.remora.feature.conversation.ApprovalsScreen
import io.github.lottooss.remora.feature.conversation.ConversationScreen
import io.github.lottooss.remora.feature.files.FilesScreen
import io.github.lottooss.remora.feature.pairing.PairingScreen
import io.github.lottooss.remora.feature.sessions.HostsScreen
import io.github.lottooss.remora.feature.sessions.SessionsScreen
import io.github.lottooss.remora.feature.settings.DiagnosticsScreen
import io.github.lottooss.remora.feature.settings.SettingsScreen
import io.github.lottooss.remora.feature.workspace.WorkspaceScreen

/**
 * The navigation graph: Pair → Hosts → Sessions → Conversation/{sessionId} →
 * Files/{sessionId}, plus NewSession, Approvals and Settings (task P1-K2).
 * Screens are placeholders; feature tasks keep the routes and fill the bodies.
 */
@Composable
fun RemoraNavHost(
    navController: NavHostController,
    modifier: Modifier = Modifier,
) {
    NavHost(
        navController = navController,
        startDestination = Routes.PAIR,
        modifier = modifier,
    ) {
        composable(Routes.PAIR) {
            PairingScreen(
                onPaired = {
                    navController.navigate(Routes.HOSTS) {
                        popUpTo(Routes.PAIR) { inclusive = true }
                    }
                },
            )
        }
        composable(Routes.HOSTS) {
            HostsScreen(onOpenSessions = { navController.navigate(Routes.SESSIONS) })
        }
        composable(Routes.SESSIONS) {
            SessionsScreen(
                onOpenConversation = { id -> navController.navigate(Routes.conversation(id)) },
                onNewSession = { navController.navigate(Routes.NEW_SESSION) },
                onOpenApprovals = { navController.navigate(Routes.APPROVALS) },
            )
        }
        composable(
            route = Routes.CONVERSATION,
            arguments = listOf(navArgument(Routes.SESSION_ID_ARG) { type = NavType.StringType }),
        ) { entry ->
            val sessionId = entry.arguments?.getString(Routes.SESSION_ID_ARG).orEmpty()
            ConversationScreen(
                sessionId = sessionId,
                onOpenFiles = { id -> navController.navigate(Routes.files(id)) },
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.NEW_SESSION) {
            WorkspaceScreen(
                onSessionCreated = { id ->
                    navController.navigate(Routes.conversation(id)) {
                        popUpTo(Routes.NEW_SESSION) { inclusive = true }
                    }
                },
                onBack = { navController.popBackStack() },
            )
        }
        composable(
            route = Routes.FILES,
            arguments = listOf(navArgument(Routes.SESSION_ID_ARG) { type = NavType.StringType }),
        ) { entry ->
            FilesScreen(
                sessionId = entry.arguments?.getString(Routes.SESSION_ID_ARG).orEmpty(),
                onBack = { navController.popBackStack() },
            )
        }
        composable(Routes.APPROVALS) {
            ApprovalsScreen()
        }
        composable(Routes.SETTINGS) {
            SettingsScreen(onOpenDiagnostics = { navController.navigate(Routes.DIAGNOSTICS) })
        }
        composable(Routes.DIAGNOSTICS) {
            DiagnosticsScreen(onBack = { navController.popBackStack() })
        }
    }
}
