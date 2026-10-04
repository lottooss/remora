package io.github.lottooss.remora.core.security

import org.junit.Assert.assertEquals
import org.junit.Test
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async

class AppLockGateTest {
    private val success = object : BiometricAuthenticator {
        override suspend fun authenticate() = true
        override suspend fun sign(hostId: String, message: ByteArray): ByteArray = error("Not used by app lock")
    }
    @Test
    fun `cold start is locked`() {
        val gate = AppLockGate(now = { 0L })
        assertEquals(LockState.LOCKED, gate.state.value)
    }

    @Test
    fun `unlock then background within timeout stays unlocked`() {
        var clock = 0L
        val gate = AppLockGate(now = { clock })
        runBlocking { gate.authenticate(success) }
        clock = AppLockGate.DEFAULT_BACKGROUND_LOCK_MS - 1
        gate.onAppBackgrounded()
        clock = AppLockGate.DEFAULT_BACKGROUND_LOCK_MS
        gate.onAppForegrounded()
        assertEquals(LockState.UNLOCKED, gate.state.value)
    }

    @Test
    fun `backgrounded past timeout re-locks on foreground`() {
        var clock = 1_000L
        val gate = AppLockGate(now = { clock })
        runBlocking { gate.authenticate(success) }
        gate.onAppBackgrounded()
        clock += AppLockGate.DEFAULT_BACKGROUND_LOCK_MS
        gate.onAppForegrounded()
        assertEquals(LockState.LOCKED, gate.state.value)
    }

    @Test
    fun `backgrounding while locked does not arm the timer`() {
        var clock = 0L
        val gate = AppLockGate(now = { clock })
        gate.onAppBackgrounded()
        clock = AppLockGate.DEFAULT_BACKGROUND_LOCK_MS * 2
        gate.onAppForegrounded()
        runBlocking { gate.authenticate(success) }
        assertEquals(LockState.UNLOCKED, gate.state.value)
    }

    @Test
    fun `explicit lock wins over foreground`() {
        val gate = AppLockGate(now = { 0L })
        runBlocking { gate.authenticate(success) }
        gate.lock()
        gate.onAppForegrounded()
        assertEquals(LockState.LOCKED, gate.state.value)
    }

    @Test
    fun `failed authentication cannot unlock`() = runBlocking {
        val gate = AppLockGate(now = { 0L })
        val failure = object : BiometricAuthenticator by success {
            override suspend fun authenticate() = false
        }
        assertEquals(false, gate.authenticate(failure))
        assertEquals(LockState.LOCKED, gate.state.value)
    }

    @Test
    fun `explicit lock invalidates authentication already in flight`() = runBlocking {
        val result = CompletableDeferred<Boolean>()
        val delayed = object : BiometricAuthenticator by success {
            override suspend fun authenticate() = result.await()
        }
        val gate = AppLockGate(now = { 0L })
        val pending = async(start = CoroutineStart.UNDISPATCHED) { gate.authenticate(delayed) }
        gate.lock()
        result.complete(true)
        assertEquals(false, pending.await())
        assertEquals(LockState.LOCKED, gate.state.value)
    }
}
