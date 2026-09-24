package io.github.lottooss.remora.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import io.github.lottooss.remora.core.security.AppLockGate
import javax.inject.Singleton

/** Hilt wiring for the P1-K2 app shell; feature ViewModels arrive with P2-K1. */
@Module
@InstallIn(SingletonComponent::class)
object AppLockModule {
    @Provides
    @Singleton
    fun provideAppLockGate(): AppLockGate = AppLockGate()
}
