import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

describe('Windows fallback dependency boundary', () => {
  it('handles a real native-loader failure without false acquisition or repeated warnings', () => {
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fallback-probe.mjs', import.meta.url))], {
      // The probe gives the helper the driver's full startup window (plus its
      // own margin) twice — a cold PowerShell/Add-Type start on a loaded
      // runner is slow; the assertions themselves stay unchanged.
      encoding: 'utf8', windowsHide: true, timeout: 45_000,
    })
    expect(output).toContain('fallback lifecycle complete')
  }, 50_000)

  if (process.platform === 'win32') {
    it('releases the real helper after its parent exits without cleanup', async () => {
      const { default: koffi } = await import('koffi')
      const kernel32 = koffi.load('kernel32.dll')
      const openProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)')
      const waitForProcess = kernel32.func('uint32 __stdcall WaitForSingleObject(void * handle, uint32 timeout)')
      const closeHandle = kernel32.func('int __stdcall CloseHandle(void * handle)')
      const parent = spawn(process.execPath, [fileURLToPath(new URL('./helper-parent.mjs', import.meta.url))], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      })
      parent.stderr.resume()
      let handle: unknown = null
      try {
        const [data] = await once(parent.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
        const helperPid = Number(String(data).trim())
        expect(Number.isSafeInteger(helperPid)).toBe(true)
        handle = openProcess(0x00100000, 0, helperPid)
        expect(handle).not.toBeNull()
        expect(waitForProcess(handle, 0)).toBe(258) // WAIT_TIMEOUT: helper alive.
        const parentExited = once(parent, 'close')
        parent.kill()
        await parentExited
        await vi.waitFor(() => expect(waitForProcess(handle, 0)).toBe(0), { timeout: 1500 })
      } finally {
        parent.kill()
        if (handle !== null) closeHandle(handle)
      }
    }, 15_000)
  }
})
