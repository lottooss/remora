import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { getLogsDir, getDailyLogPath, getDshHomeDir } from './paths.ts'
import { getServiceDir, supervisorIsAlive } from './process-state.ts'
import { resolveDshRuntime } from './runtime.ts'
import { CliUsageError, validatePort, validateProfile, validateTaskName } from './options.ts'

export interface SupervisorOptions {
  profile?: string
  port?: number
  dshHome?: string
  taskName?: string
  maxLogDays?: number
}

/** Remove only Remora daily logs older than the retention period. */
export function rotateLogs(logsDir: string, maxDays: number = 14): void {
  fs.mkdirSync(logsDir, { recursive: true })
  const oldest = Date.now() - maxDays * 86_400_000
  for (const file of fs.readdirSync(logsDir)) {
    if (!/^remora-\d{4}-\d{2}-\d{2}\.log$/.test(file)) continue
    const filePath = path.join(logsDir, file)
    try {
      if (fs.lstatSync(filePath).isFile() && fs.statSync(filePath).mtimeMs < oldest) fs.unlinkSync(filePath)
    } catch { /* Retention failure must not interrupt the host. */ }
  }
}

/** One direct Node child, capped restart delay, and an owned stop-request file. */
export class HostSupervisor {
  private readonly profile: string
  private readonly port: number
  private readonly dshHome: string
  private readonly taskName: string
  private readonly logsDir: string
  private readonly maxLogDays: number
  private readonly abort = new AbortController()
  private childProcess: ChildProcess | null = null
  private stopping = false
  private started = false

  constructor(options: SupervisorOptions = {}) {
    this.profile = validateProfile(options.profile ?? 'remora')
    this.port = validatePort(options.port ?? 7717)
    this.dshHome = path.resolve(options.dshHome ?? getDshHomeDir())
    this.taskName = validateTaskName(options.taskName ?? 'RemoraHost')
    this.logsDir = getLogsDir(this.taskName)
    this.maxLogDays = options.maxLogDays ?? 14
    if (!Number.isInteger(this.maxLogDays) || this.maxLogDays < 1 || this.maxLogDays > 365) {
      throw new CliUsageError('Log retention must be between 1 and 365 days.')
    }
  }

  private appendLog(message: string): void {
    try {
      fs.mkdirSync(this.logsDir, { recursive: true })
      const logPath = getDailyLogPath(new Date(), this.taskName)
      // Logs contain fixed lifecycle facts only. No dsh output, token URLs or content.
      if (fs.existsSync(logPath) && fs.statSync(logPath).size >= 1024 * 1024) return
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch { /* Log storage failure must not expose raw errors or crash dsh. */ }
  }

  async start(): Promise<void> {
    if (this.started) throw new CliUsageError('Supervisor has already been started.')
    this.started = true
    const entry = resolveDshRuntime()
    if (!fs.statSync(this.dshHome).isDirectory()) throw new CliUsageError('DSH_HOME must exist before starting the host.')
    const directory = getServiceDir(this.taskName)
    fs.mkdirSync(directory, { recursive: true })
    const statePath = path.join(directory, 'supervisor.json')
    const stopPath = path.join(directory, 'stop-request')
    if (supervisorIsAlive(this.taskName)) throw new CliUsageError('This supervisor is already running or its state needs operator attention.')
    fs.rmSync(statePath, { force: true })
    // Exclusive creation prevents logon and manual starts racing into two hosts.
    fs.writeFileSync(statePath, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
    const onSignal = () => this.stop()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    const stopWatcher = setInterval(() => {
      if (fs.existsSync(stopPath)) this.stop()
    }, 200)
    try {
      if (fs.existsSync(stopPath)) return
      this.appendLog(`Supervisor started; profile=${this.profile}; port=${this.port}.`)
      rotateLogs(this.logsDir, this.maxLogDays)
      let backoffMs = 1000
      while (!this.stopping) {
        const startTime = Date.now()
        const code = await this.spawnDshOnce(entry)
        if (this.stopping) break
        const uptimeMs = Date.now() - startTime
        this.appendLog(`dsh exited; code=${code ?? 'signal'}; uptimeSeconds=${Math.round(uptimeMs / 1000)}.`)
        if (uptimeMs >= 60_000) backoffMs = 1000
        this.appendLog(`Restart scheduled; delayMs=${backoffMs}.`)
        rotateLogs(this.logsDir, this.maxLogDays)
        try { await delay(backoffMs, undefined, { signal: this.abort.signal }) } catch { break }
        backoffMs = Math.min(backoffMs * 2, 30_000)
      }
    } finally {
      clearInterval(stopWatcher)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      fs.rmSync(statePath, { force: true })
      this.appendLog('Supervisor stopped.')
    }
  }

  private spawnDshOnce(entry: string): Promise<number | null> {
    return new Promise((resolve) => {
      this.appendLog('Starting pinned dsh runtime.')
      // dsh's stdout can contain a browser launch credential and user content.
      // Operators use a separate interactive dsh launch for its authenticated URL.
      const child = spawn(process.execPath, [entry, '--profile', this.profile, '--port', String(this.port), '--no-open'], {
        stdio: 'ignore', shell: false, windowsHide: true,
        cwd: this.dshHome, env: { ...process.env, DSH_HOME: this.dshHome },
        detached: process.platform !== 'win32',
      })
      this.childProcess = child
      child.once('error', () => this.appendLog('Unable to launch dsh; inspect the dedicated runtime installation.'))
      child.once('close', (code) => {
        if (this.childProcess === child) this.childProcess = null
        resolve(code)
      })
    })
  }

  /** Stop only the child created by this supervisor; never kill from a stored PID. */
  stop(): void {
    if (this.stopping) return
    this.stopping = true
    this.abort.abort()
    const child = this.childProcess
    if (child === null || child.pid === undefined) return
    if (process.platform === 'win32') {
      // Windows lacks POSIX signals: terminate the owned process tree, including tools.
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => {
        if (error) {
          this.appendLog('Windows process-tree termination failed; attempting direct child termination.')
          child.kill()
        }
      })
    } else {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
      const deadline = setTimeout(() => {
        if (this.childProcess !== child || child.pid === undefined) return
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }, 3000)
      deadline.unref()
      child.once('close', () => clearTimeout(deadline))
    }
  }
}
