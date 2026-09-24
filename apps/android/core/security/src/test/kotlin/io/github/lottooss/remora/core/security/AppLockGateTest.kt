package io.github.lottooss.remora.core.security

import org.junit.Assert.assertEquals
import org.junit.Test

class AppLockGateTest {
    @Test
    fun `cold start is locked`() {
        val gate = AppLockGate(now = { 0L })
        assertEquals(LockState.LOCKED, gate.state.value)
    }

    @Test
    fun `unlock then background within timeout stays unlocked`() {
        var clock = 0L
        val gate = AppLockGate(now = { clock })
        gate.unlock()
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
        gate.unlock()
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
        gate.unlock()
        assertEquals(LockState.UNLOCKED, gate.state.value)
    }

    @Test
    fun `explicit lock wins over foreground`() {
        val gate = AppLockGate(now = { 0L })
        gate.unlock()
        gate.lock()
        gate.onAppForegrounded()
        assertEquals(LockState.LOCKED, gate.state.value)
    }
}
