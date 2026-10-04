package io.github.lottooss.remora.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.github.lottooss.remora.core.data.DefaultHostRepository
import io.github.lottooss.remora.core.data.HostRepository
import io.github.lottooss.remora.core.data.PushTokenRegistrar
import io.github.lottooss.remora.core.transport.ConnectionManager
import io.github.lottooss.remora.core.transport.RelayClient
import io.github.lottooss.remora.core.security.KeyStorage
import io.github.lottooss.remora.core.security.SecureKeyStorage
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object RepositoryModule {

    @Provides
    @Singleton
    fun provideKeyStorage(@ApplicationContext context: Context): KeyStorage =
        SecureKeyStorage(context)

    @Provides
    @Singleton
    fun provideHostRepository(
        @ApplicationContext context: Context,
        keyStorage: KeyStorage,
    ): HostRepository = DefaultHostRepository(context, keyStorage)

    @Provides
    @Singleton
    fun provideForegroundConnections(): ForegroundConnections = ForegroundConnections()

    @Provides
    @Singleton
    fun providePushTokenRegistrar(
        @ApplicationContext context: Context,
        hosts: HostRepository,
        keys: KeyStorage,
        connections: ForegroundConnections,
    ): PushTokenRegistrar = PushTokenRegistrar(context, hosts, keys, connections::relayForHost,
        temporaryConnectionsAllowed = { !connections.hasLease })
}

/** Application-scoped lookup for FCM; never retains an Activity or its ViewModel. */
class ForegroundConnections {
    @Volatile var hasLease: Boolean = false
    @Volatile private var connections: Map<String, ConnectionManager> = emptyMap()
    fun replace(value: Map<String, ConnectionManager>) { connections = value.toMap() }
    fun relayForHost(hostId: String): RelayClient? = connections[hostId]?.relayClient?.value
}
