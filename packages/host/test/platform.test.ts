import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  KeepAwakeManager,
  NoopKeepAwakeDriver,
  createKeepAwakeDriver,
} from '../src/platform/index.ts'

describe('KeepAwakeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('acquires lock when an agent becomes busy and releases after 2-minute grace', () => {
    const driver = new NoopKeepAwakeDriver()
    const manager = new KeepAwakeManager({ driver, gracePeriodMs: 120_000, enabled: true })

    expect(driver.isAcquired).toBe(false)
    expect(manager.isAcquired).toBe(false)

    // Agent 1 becomes busy
    manager.handleAgentStatus('agent-1', 'busy')
    expect(driver.isAcquired).toBe(true)
    expect(manager.activeAgentCount).toBe(1)
    expect(manager.isGracePeriodActive).toBe(false)

    // Agent 1 becomes idle -> starts grace period
    manager.handleAgentStatus('agent-1', 'idle')
    expect(manager.activeAgentCount).toBe(0)
    expect(driver.isAcquired).toBe(true) // Still held during grace
    expect(manager.isGracePeriodActive).toBe(true)

    // Advance 60s (halfway)
    vi.advanceTimersByTime(60_000)
    expect(driver.isAcquired).toBe(true)

    // Advance remaining 60s -> grace period expires
    vi.advanceTimersByTime(60_000)
    expect(driver.isAcquired).toBe(false)
    expect(manager.isGracePeriodActive).toBe(false)
  })

  it('cancels grace timer if agent becomes busy again before expiry', () => {
    const driver = new NoopKeepAwakeDriver()
    const manager = new KeepAwakeManager({ driver, gracePeriodMs: 120_000, enabled: true })

    manager.handleAgentStatus('agent-1', 'running')
    expect(driver.isAcquired).toBe(true)

    manager.handleAgentStatus('agent-1', 'idle')
    expect(manager.isGracePeriodActive).toBe(true)

    // 30s pass
    vi.advanceTimersByTime(30_000)
    expect(driver.isAcquired).toBe(true)

    // Agent 2 becomes busy
    manager.handleAgentStatus('agent-2', 'busy')
    expect(manager.isGracePeriodActive).toBe(false) // Grace timer cancelled

    // Advance 120s: should still be held because agent-2 is active
    vi.advanceTimersByTime(120_000)
    expect(driver.isAcquired).toBe(true)

    // Agent 2 finishes
    manager.handleAgentStatus('agent-2', 'idle')
    expect(manager.isGracePeriodActive).toBe(true)

    vi.advanceTimersByTime(120_000)
    expect(driver.isAcquired).toBe(false)
  })

  it('releases immediately on dispose', () => {
    const driver = new NoopKeepAwakeDriver()
    const manager = new KeepAwakeManager({ driver, gracePeriodMs: 120_000, enabled: true })

    manager.handleAgentStatus('agent-1', 'busy')
    expect(driver.isAcquired).toBe(true)

    manager.dispose()
    expect(driver.isAcquired).toBe(false)
    expect(manager.activeAgentCount).toBe(0)
    expect(manager.isGracePeriodActive).toBe(false)
  })

  it('respects enabled: false (off mode)', () => {
    const driver = new NoopKeepAwakeDriver()
    const manager = new KeepAwakeManager({ driver, enabled: false })

    manager.handleAgentStatus('agent-1', 'busy')
    expect(driver.isAcquired).toBe(false)
    expect(manager.activeAgentCount).toBe(0)
  })

  it('createKeepAwakeDriver instantiates platform drivers correctly', () => {
    const win = createKeepAwakeDriver('win32')
    expect(win).toBeDefined()
    expect(win.isAcquired).toBe(false)

    const mac = createKeepAwakeDriver('darwin')
    expect(mac).toBeDefined()

    const linux = createKeepAwakeDriver('linux')
    expect(linux).toBeDefined()

    const fallback = createKeepAwakeDriver('freebsd')
    expect(fallback).toBeInstanceOf(NoopKeepAwakeDriver)
  })
})
