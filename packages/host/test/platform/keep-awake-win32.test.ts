import { afterEach, describe, expect, it, vi } from 'vitest'
import { KeepAwakeManager } from '../../src/platform/keep-awake.ts'
import { Win32KeepAwakeDriver } from '../../src/platform/keep-awake-win32.ts'

const ES_CONTINUOUS = 0x80000000
const ES_SYSTEM_REQUIRED = 0x00000001
const drivers = new Set<Win32KeepAwakeDriver>()

function createDriver(): Win32KeepAwakeDriver {
  const driver = new Win32KeepAwakeDriver()
  drivers.add(driver)
  return driver
}

afterEach(() => {
  for (const driver of drivers) driver.release()
  drivers.clear()
})

describe('Windows keep-awake acquisition lifecycle', () => {
  it('does not report acquisition before the asynchronous native import succeeds', () => {
    const driver = createDriver()
    driver.acquire()
    expect(driver.isAcquired).toBe(false)
  })

  it('cancels an acquisition released while the native module is loading', async () => {
    const driver = createDriver()
    driver.acquire()
    driver.release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(driver.isAcquired).toBe(false)
  })

  it('starts the idle grace period even while acquisition is pending', () => {
    const manager = new KeepAwakeManager({ driver: createDriver(), gracePeriodMs: 120_000 })
    try {
      manager.handleAgentStatus('root-agent', 'running')
      manager.handleAgentStatus('root-agent', 'idle')
      expect(manager.isGracePeriodActive).toBe(true)
    } finally {
      manager.dispose()
    }
  })

  it('ignores late status events after manager disposal', async () => {
    const manager = new KeepAwakeManager({ driver: createDriver() })
    manager.dispose()
    manager.handleAgentStatus('root-agent', 'running')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(manager.activeAgentCount).toBe(0)
    expect(manager.isAcquired).toBe(false)
  })
})

// The native acceptance checks register only on Windows. The lifecycle tests
// above still run on every platform; no OS API or production driver is mocked.
if (process.platform === 'win32') {
  describe('Windows kernel execution-state integration', () => {
    it('holds SYSTEM_REQUIRED on the calling thread and clears it on release', async () => {
      const { default: koffi } = await import('koffi')
      const kernel32 = koffi.load('kernel32.dll')
      const setExecutionState = kernel32.func('uint32 __stdcall SetThreadExecutionState(uint32 flags)')
      // Read the previous thread state and immediately restore it. The observer
      // never establishes SYSTEM_REQUIRED itself, avoiding a self-fulfilling test.
      const readExecutionState = (): number => {
        const previous: unknown = setExecutionState(ES_CONTINUOUS)
        if (typeof previous !== 'number' || previous === 0) {
          throw new Error('Windows did not return the prior execution state')
        }
        setExecutionState(previous)
        return previous
      }
      const driver = createDriver()
      const initialExecutionState = readExecutionState()
      try {
        expect(initialExecutionState & ES_SYSTEM_REQUIRED).toBe(0)
        driver.acquire()
        await vi.waitFor(() => expect(driver.isAcquired).toBe(true))
        expect(readExecutionState() & ES_SYSTEM_REQUIRED).toBe(ES_SYSTEM_REQUIRED)
        driver.release()
        expect(readExecutionState() & ES_SYSTEM_REQUIRED).toBe(0)
        expect(driver.isAcquired).toBe(false)
      } finally {
        driver.release()
        setExecutionState(initialExecutionState)
      }
    })
  })
}
