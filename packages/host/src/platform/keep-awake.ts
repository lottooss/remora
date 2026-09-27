import type { KeepAwakeDriver } from './keep-awake-noop.ts'
import { NoopKeepAwakeDriver } from './keep-awake-noop.ts'
import { Win32KeepAwakeDriver } from './keep-awake-win32.ts'
import { DarwinKeepAwakeDriver } from './keep-awake-darwin.ts'
import { LinuxKeepAwakeDriver } from './keep-awake-linux.ts'

export * from './keep-awake-noop.ts'
export * from './keep-awake-win32.ts'
export * from './keep-awake-darwin.ts'
export * from './keep-awake-linux.ts'

export function createKeepAwakeDriver(platform: string = process.platform): KeepAwakeDriver {
  switch (platform) {
    case 'win32':
      return new Win32KeepAwakeDriver()
    case 'darwin':
      return new DarwinKeepAwakeDriver()
    case 'linux':
      return new LinuxKeepAwakeDriver()
    default:
      return new NoopKeepAwakeDriver()
  }
}

export interface KeepAwakeOptions {
  driver?: KeepAwakeDriver
  gracePeriodMs?: number
  enabled?: boolean
}

export class KeepAwakeManager {
  private readonly driver: KeepAwakeDriver
  private readonly gracePeriodMs: number
  private readonly enabled: boolean
  private readonly busyAgents = new Set<string>()
  private graceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: KeepAwakeOptions = {}) {
    this.driver = options.driver ?? createKeepAwakeDriver()
    this.gracePeriodMs = options.gracePeriodMs ?? 120_000
    this.enabled = options.enabled ?? true
  }

  handleAgentStatus(agentId: string, status: string): void {
    if (!this.enabled) return

    const isBusy = status === 'busy' || status === 'running'
    if (isBusy) {
      this.busyAgents.add(agentId)
      if (this.graceTimer !== null) {
        clearTimeout(this.graceTimer)
        this.graceTimer = null
      }
      this.driver.acquire()
    } else {
      this.busyAgents.delete(agentId)
      if (this.busyAgents.size === 0 && this.driver.isAcquired) {
        if (this.graceTimer === null) {
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null
            if (this.busyAgents.size === 0) {
              this.driver.release()
            }
          }, this.gracePeriodMs)
        }
      }
    }
  }

  dispose(): void {
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
    this.busyAgents.clear()
    this.driver.release()
  }

  get isAcquired(): boolean {
    return this.driver.isAcquired
  }

  get activeAgentCount(): number {
    return this.busyAgents.size
  }

  get isGracePeriodActive(): boolean {
    return this.graceTimer !== null
  }
}
