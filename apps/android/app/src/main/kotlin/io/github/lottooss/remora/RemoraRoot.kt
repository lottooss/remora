package io.github.lottooss.remora

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.AddCircle
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.currentBackStackEntryAsState

private data class TopLevelDestination(
    val route: String,
    val label: Int,
    val icon: ImageVector,
)

private val topLevelDestinations = listOf(
    TopLevelDestination(Routes.PAIR, R.string.nav_pair, Icons.Filled.AddCircle),
    TopLevelDestination(Routes.HOSTS, R.string.nav_hosts, Icons.Filled.Home),
    TopLevelDestination(Routes.SESSIONS, R.string.nav_sessions, Icons.AutoMirrored.Filled.List),
    TopLevelDestination(Routes.APPROVALS, R.string.nav_approvals, Icons.Filled.CheckCircle),
    TopLevelDestination(Routes.SETTINGS, R.string.nav_settings, Icons.Filled.Settings),
)

/**
 * App shell: [RemoraNavHost] plus the bottom navigation bar for top-level
 * destinations (Pair, Hosts, Sessions, Approvals, Settings). The bar hides on
 * pushed destinations such as Conversation, Files and Diagnostics.
 */
@Composable
fun RemoraRoot(
    navController: NavHostController,
    model: RemoraViewModel,
    approvalSigner: suspend (String, ByteArray) -> ByteArray,
    modifier: Modifier = Modifier,
) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry?.destination?.route
    val onTopLevel = currentRoute != null && currentRoute in Routes.TOP_LEVEL

    Column(modifier.fillMaxSize()) {
        RemoraNavHost(
            navController = navController,
            model = model,
            approvalSigner = approvalSigner,
            modifier = Modifier
                .weight(1f)
                .fillMaxSize(),
        )
        if (onTopLevel) {
            NavigationBar {
                topLevelDestinations.forEach { destination ->
                    NavigationBarItem(
                        selected = currentRoute == destination.route,
                        onClick = {
                            navController.navigate(destination.route) {
                                popUpTo(navController.graph.findStartDestination().id) {
                                    saveState = true
                                }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = { Icon(destination.icon, contentDescription = null) },
                        label = { Text(stringResource(destination.label)) },
                    )
                }
            }
        }
    }
}

/** The only action launches system authentication; this screen cannot unlock the gate. */
@Composable
fun AppLockScreen(
    onAuthenticate: () -> Unit,
    authenticating: Boolean,
    authenticationFailed: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(stringResource(R.string.lock_title), style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.lock_description),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (authenticationFailed) {
            Text(stringResource(R.string.lock_failed), color = MaterialTheme.colorScheme.error)
        }
        Button(onClick = onAuthenticate, enabled = !authenticating, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(if (authenticating) R.string.lock_waiting else R.string.lock_unlock))
        }
    }
}
