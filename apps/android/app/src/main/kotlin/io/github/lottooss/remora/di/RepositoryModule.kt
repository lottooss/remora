package io.github.lottooss.remora.di

import android.content.Context
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.github.lottooss.remora.core.data.DefaultHostRepository
import io.github.lottooss.remora.core.data.HostRepository
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
}
