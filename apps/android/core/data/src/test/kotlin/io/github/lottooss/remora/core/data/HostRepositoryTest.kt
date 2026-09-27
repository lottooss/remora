package io.github.lottooss.remora.core.data

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.model.Host
import io.github.lottooss.remora.core.model.HostId
import kotlinx.coroutines.runBlocking
import org.junit.Test

class HostRepositoryTest {

    @Test
    fun testAddUpdateRemoveHost() = runBlocking {
        val repo = DefaultHostRepository()

        val host1 = Host(
            id = HostId("h_test1234567890123456789012"),
            name = "Test Host 1",
            relayOrigin = "https://relay.example.com",
            hostNoisePub = ByteArray(32) { 0x11 },
            isOnline = false,
            lastSeenAt = 1000L,
        )

        repo.addHost(host1)
        assertThat(repo.hosts.value).contains(host1)
        assertThat(repo.activeHost.value).isEqualTo(host1)

        val updated = host1.copy(isOnline = true, lastSeenAt = 2000L)
        repo.updateHost(updated)
        assertThat(repo.activeHost.value?.isOnline).isTrue()
        assertThat(repo.activeHost.value?.lastSeenAt).isEqualTo(2000L)

        repo.removeHost(host1.id)
        assertThat(repo.hosts.value).isEmpty()
        assertThat(repo.activeHost.value).isNull()
    }
}
