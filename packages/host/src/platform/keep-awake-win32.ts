import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { KeepAwakeDriver } from './keep-awake-noop.ts'
import { spawnWindowsKeepAwakeHelper } from './keep-awake-win32-helper.ts'

const ES_SYSTEM_REQUIRED = 0x00000001
const ES_CONTINUOUS = 0x80000000
const HELPER_READY = 'remora-keepawake-ready\r\n'
const HELPER_START_TIMEOUT_MS = 10_000

export interface Win32KeepAwakeOptions {
  warn?: (message: string) => void
}

/** Windows idle-sleep inhibition, scoped to this driver's acquire/release lifetime. */
export class Win32KeepAwakeDriver implements KeepAwakeDriver {
  private wanted = false
  private nativeAcquired = false
  private setExecutionState: ((flags: number) => number) | null = null
  private initialized = false
  private loading: Promise<void> | null = null
  private helper: ChildProcessWithoutNullStreams | null = null
  private helperAcquired = false
  private helperStopping = false
  private helperRestartRequested = false
  private helperTimer: ReturnType<typeof setTimeout> | null = null
  private readonly warned = new Set<string>()
  private readonly options: Win32KeepAwakeOptions

  constructor(options: Win32KeepAwakeOptions = {}) {
    this.options = options
  }

  private warnOnce(code: string, message: string): void {
    if (this.warned.has(code)) return
    this.warned.add(code)
    this.options.warn?.(message)
  }

  private async initialize(): Promise<void> {
    try {
      const { default: koffi } = await import('koffi')
      const kernel32 = koffi.load('kernel32.dll')
      const setExecutionState = kernel32.func('uint32 __stdcall SetThreadExecutionState(uint32 flags)')
      // Execution state belongs to the calling thread. Never use koffi's async
      // calls here: libuv could acquire and release on different worker threads.
      this.setExecutionState = (flags) => setExecutionState(flags) as number
    } catch {
      this.warnOnce('native', 'remora: native Windows keep-awake unavailable; using a hidden PowerShell helper')
    }
    this.initialized = true
    if (this.wanted) this.acquireInitialized()
  }

  private acquireInitialized(): void {
    if (this.nativeAcquired || this.helper !== null) return
    if (this.setExecutionState !== null) {
      try {
        // Bitwise operators produce signed int32; the FFI contract is uint32.
        this.nativeAcquired = this.setExecutionState((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0) !== 0
        if (this.nativeAcquired) return
      } catch {
        // A binding can load yet fail on invocation; the helper uses the same OS contract.
      }
      this.setExecutionState = null
      this.warnOnce('native', 'remora: native Windows keep-awake unavailable; using a hidden PowerShell helper')
    }
    this.startHelper()
  }

  private clearHelperTimer(): void {
    if (this.helperTimer !== null) clearTimeout(this.helperTimer)
    this.helperTimer = null
  }

  private startHelper(): void {
    let helper: ChildProcessWithoutNullStreams
    try {
      helper = spawnWindowsKeepAwakeHelper()
    } catch {
      this.warnOnce('helper', 'remora: Windows keep-awake helper could not start; idle sleep is not prevented')
      return
    }
    this.helper = helper
    this.helperAcquired = false
    this.helperStopping = false
    let response = ''
    helper.stdout.setEncoding('utf8')
    helper.stdout.on('data', (chunk: string) => {
      if (this.helper !== helper || this.helperStopping) return
      response += chunk
      if (response.length > HELPER_READY.length || !HELPER_READY.startsWith(response)) {
        this.warnOnce('helper', 'remora: Windows keep-awake helper failed; idle sleep is not prevented')
        this.stopHelper()
      } else if (response === HELPER_READY) {
        this.clearHelperTimer()
        this.helperAcquired = true
        if (!this.wanted) this.stopHelper()
      }
    })
    // Compiler/runtime diagnostics can contain machine paths. Drain, never log.
    helper.stderr.resume()
    helper.stdin.on('error', () => {
      // EPIPE is expected when a failed or terminated helper closes its input.
    })
    helper.once('error', () => {
      if (this.helper !== helper) return
      this.clearHelperTimer()
      this.helperAcquired = false
      this.warnOnce('helper', 'remora: Windows keep-awake helper failed; idle sleep is not prevented')
    })
    helper.once('close', () => {
      if (this.helper !== helper) return
      const restart = this.helperRestartRequested && this.wanted
      if (!this.helperStopping && this.wanted) {
        this.warnOnce('helper', 'remora: Windows keep-awake helper exited; idle sleep is not prevented')
      }
      this.clearHelperTimer()
      this.helper = null
      this.helperAcquired = false
      this.helperStopping = false
      this.helperRestartRequested = false
      if (restart) this.acquireInitialized()
    })
    this.helperTimer = setTimeout(() => {
      this.warnOnce('helper', 'remora: Windows keep-awake helper timed out; idle sleep is not prevented')
      this.stopHelper()
    }, HELPER_START_TIMEOUT_MS)
    this.helperTimer.unref()
  }

  private stopHelper(): void {
    this.clearHelperTimer()
    if (this.helper === null || this.helperStopping) return
    this.helperStopping = true
    this.helper.stdin.end()
    // Windows terminates this exact child; no shell or descendant process owns
    // the request. Kernel cleanup also releases it if the process is killed.
    this.helper.kill()
  }

  /** Request inhibition; isAcquired becomes true only after the OS accepts it. */
  acquire(): void {
    this.wanted = true
    if (this.helperStopping) this.helperRestartRequested = true
    if (this.initialized) {
      this.acquireInitialized()
    } else {
      this.loading ??= this.initialize()
    }
  }

  /** Cancel pending loading/helper startup and release an established request. */
  release(): void {
    this.wanted = false
    this.helperRestartRequested = false
    if (this.nativeAcquired && this.setExecutionState !== null) {
      try {
        if (this.setExecutionState(ES_CONTINUOUS) !== 0) this.nativeAcquired = false
      } catch {
        // Keep the acquired flag truthful and allow another release attempt.
      }
      if (this.nativeAcquired) {
        this.warnOnce('release', 'remora: Windows keep-awake release failed; the request may remain until host exit')
      }
    }
    this.stopHelper()
  }

  get isAcquired(): boolean {
    return this.nativeAcquired || this.helperAcquired
  }
}
