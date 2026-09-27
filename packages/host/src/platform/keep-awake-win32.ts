import type { KeepAwakeDriver } from './keep-awake-noop.ts'

const ES_SYSTEM_REQUIRED = 0x00000001
const ES_CONTINUOUS = 0x80000000

export class Win32KeepAwakeDriver implements KeepAwakeDriver {
  private _isAcquired = false
  private setThreadExecutionState: ((flags: number) => number) | null = null
  private initAttempted = false

  private initNative(): void {
    if (this.initAttempted) return
    this.initAttempted = true
    try {
      // Attempt dynamic load of koffi if available in environment
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const koffi = (globalThis as unknown as { koffi?: { load(lib: string): { func(decl: string): (flags: number) => number } } }).koffi
      if (koffi) {
        const kernel32 = koffi.load('kernel32.dll')
        this.setThreadExecutionState = kernel32.func('uint32 __stdcall SetThreadExecutionState(uint32 esFlags)')
      }
    } catch {
      this.setThreadExecutionState = null
    }
  }

  acquire(): void {
    this._isAcquired = true
    this.initNative()
    if (this.setThreadExecutionState) {
      try {
        this.setThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
      } catch {
        // Fail-safe
      }
    }
  }

  release(): void {
    this._isAcquired = false
    this.initNative()
    if (this.setThreadExecutionState) {
      try {
        this.setThreadExecutionState(ES_CONTINUOUS)
      } catch {
        // Fail-safe
      }
    }
  }

  get isAcquired(): boolean {
    return this._isAcquired
  }
}
