import fs from 'node:fs'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { getLogsDir, getDailyLogPath } from './paths.ts'

export interface SupervisorOptions {
  profile?: string
  port?: number
  dshCommand?: string
  maxLogDays?: number
}

export function rotateLogs(logsDir: string, maxDays: number = 14): void {
  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
      return
    }
    const files = fs.readdirSync(logsDir)
    const now = Date.now()
    const maxAgeMs = maxDays * 24 * 60 * 60 * 1000

    for (const file of files) {
      if (!file.startsWith('remora-') || !file.endsWith('.log')) continue
      const filePath = path.join(logsDir, file)
      try {
        const stats = fs.statSync(filePath)
        if (now - stats.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // Ignore stat or unlink errors
      }
    }
  } catch {
    // Non-fatal
  }
}

export class HostSupervisor {
  private readonly profile: string
  private readonly port: number
  private readonly dshCommand: string
  private readonly logsDir: string
  private readonly maxLogDays: number
  private childProcess: ChildProcess | null = null
  private stopping = false
  private currentBackoffMs = 1000
  private readonly maxBackoffMs = 30_000

  constructor(options: SupervisorOptions = {}) {
    this.profile = options.profile ?? 'remora'
    this.port = options.port ?? 7717
    this.dshCommand = options.dshCommand ?? 'dsh'
    this.logsDir = getLogsDir()
    this.maxLogDays = options.maxLogDays ?? 14
  }

  private appendLog(message: string): void {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true })
      }
      const logPath = getDailyLogPath()
      const timestamp = new Date().toISOString()
      fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`, 'utf8')
    } catch {
      // Ignored
    }
  }

  async start(): Promise<void> {
    this.appendLog(`HostSupervisor started (profile: ${this.profile}, port: ${this.port})`)
    rotateLogs(this.logsDir, this.maxLogDays)

    const onSignal = () => {
      this.stop()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    while (!this.stopping) {
      const startTime = Date.now()
      this.appendLog(`Spawning ${this.dshCommand} --profile ${this.profile} --port ${this.port} --no-open`)

      const code = await this.spawnDshOnce()
      if (this.stopping) break

      const uptimeMs = Date.now() - startTime
      this.appendLog(`dsh exited with code ${code} after ${Math.round(uptimeMs / 1000)}s`)

      // If healthy for 60s, reset backoff
      if (uptimeMs >= 60_000) {
        this.currentBackoffMs = 1000
      } else {
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.maxBackoffMs)
      }

      this.appendLog(`Restarting in ${this.currentBackoffMs}ms...`)
      rotateLogs(this.logsDir, this.maxLogDays)
      await new Promise((resolve) => setTimeout(resolve, this.currentBackoffMs))
    }

    this.appendLog('HostSupervisor stopped cleanly.')
  }

  private spawnDshOnce(): Promise<number | null> {
    return new Promise((resolve) => {
      const logStream = fs.createWriteStream(getDailyLogPath(), { flags: 'a' })
      const child = spawn(
        this.dshCommand,
        ['--profile', this.profile, '--port', String(this.port), '--no-open'],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        },
      )
      this.childProcess = child

      if (child.stdout) {
        child.stdout.pipe(logStream)
      }
      if (child.stderr) {
        child.stderr.pipe(logStream)
      }

      child.on('error', (err) => {
        this.appendLog(`Failed to spawn ${this.dshCommand}: ${err.message}`)
        resolve(-1)
      })

      child.on('exit', (code) => {
        this.childProcess = null
        logStream.end()
        resolve(code)
      })
    })
  }

  stop(): void {
    if (this.stopping) return
    this.stopping = true
    this.appendLog('Received stop signal, terminating dsh child process...')
    if (this.childProcess) {
      try {
        this.childProcess.kill('SIGTERM')
      } catch {
        // Ignored
      }
    }
  }
}
