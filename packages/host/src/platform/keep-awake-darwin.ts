import { spawn, type ChildProcess } from 'node:child_process'
import type { KeepAwakeDriver } from './keep-awake-noop.ts'

export class DarwinKeepAwakeDriver implements KeepAwakeDriver {
  private _isAcquired = false
  private process: ChildProcess | null = null

  acquire(): void {
    if (this._isAcquired) return
    this._isAcquired = true
    try {
      this.process = spawn('caffeinate', ['-i'], {
        stdio: 'ignore',
        detached: false,
      })
      this.process.on('error', () => {
        this.process = null
      })
    } catch {
      this.process = null
    }
  }

  release(): void {
    if (!this._isAcquired) return
    this._isAcquired = false
    if (this.process) {
      try {
        this.process.kill()
      } catch {
        // Ignored
      }
      this.process = null
    }
  }

  get isAcquired(): boolean {
    return this._isAcquired
  }
}
