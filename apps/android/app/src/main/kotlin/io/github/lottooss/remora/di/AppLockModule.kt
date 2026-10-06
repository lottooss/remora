package io.github.lottooss.remora.di

import android.os.SystemClock
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import io.github.lottooss.remora.core.security.AppLockGate
import javax.inject.Singleton

/** Uses monotonic time so wall-clock changes cannot extend the background timeout. */
@Module
@InstallIn(SingletonComponent::class)
object AppLockModule {
    @Provides
    @Singleton
    fun provideAppLockGate(): AppLockGate = AppLockGate(now = SystemClock::elapsedRealtime)
}
