package io.github.lottooss.remora.feature.sessions

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.model.Host
import java.text.DateFormat
import java.util.Date

/** Paired hosts, live presence, and explicit host-bound navigation. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HostsScreen(
    hosts: List<Host>,
    activeHostId: String?,
    onOpenSessions: (String) -> Unit,
    onPair: () -> Unit,
    onUnpair: (String) -> Unit,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = null,
    busyHostId: String? = null,
    errorCode: String? = null,
) {
    var confirmHost by remember { mutableStateOf<Host?>(null) }
    Scaffold(modifier = modifier.fillMaxSize(), topBar = {
        TopAppBar(title = { Text(stringResource(R.string.hosts_title)) }, navigationIcon = {
            if (onBack != null) TextButton(onClick = onBack) { Text(stringResource(R.string.hosts_back)) }
        })
    }) { padding ->
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Button(onClick = onPair, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.hosts_pair)) } }
            if (errorCode != null) item { Text(stringResource(R.string.hosts_error), color = MaterialTheme.colorScheme.error) }
            if (hosts.isEmpty()) item { Text(stringResource(R.string.hosts_empty)) }
            items(hosts, key = { it.id.value }) { host ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(host.name, style = MaterialTheme.typography.titleLarge)
                        Text(stringResource(if (host.isOnline) R.string.hosts_online else R.string.hosts_offline),
                            color = if (host.isOnline) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        if (host.id.value == activeHostId) Text(stringResource(R.string.hosts_selected))
                        Text(if (host.lastSeenAt > 0) stringResource(R.string.hosts_last_seen,
                            DateFormat.getDateTimeInstance().format(Date(host.lastSeenAt))) else stringResource(R.string.hosts_never_seen))
                        Button(onClick = { onOpenSessions(host.id.value) }, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.hosts_open))
                        }
                        OutlinedButton(onClick = { confirmHost = host }, enabled = busyHostId == null,
                            modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.hosts_unpair)) }
                        if (busyHostId == host.id.value) LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                }
            }
        }
    }
    confirmHost?.let { host ->
        AlertDialog(onDismissRequest = { confirmHost = null },
            title = { Text(stringResource(R.string.hosts_unpair_title, host.name)) },
            text = { Text(stringResource(R.string.hosts_unpair_body)) },
            confirmButton = { TextButton(onClick = { confirmHost = null; onUnpair(host.id.value) }) { Text(stringResource(R.string.hosts_unpair)) } },
            dismissButton = { TextButton(onClick = { confirmHost = null }) { Text(stringResource(R.string.hosts_cancel)) } })
    }
}
