/**
 * RealDshHarness: drives the REAL DeepSeek Harness CLI (`dsh`) and the REAL
 * relay (`wrangler dev`) as child processes. No mocks: dsh, @remora/host and
 * the relay all run for real, isolated inside a temporary DSH_HOME and
 * temporary directories so the owner's `~/.dsh` is never touched.
 *
 * Every subprocess output is collected in memory (for assertions) and appended
 * to a file under tests/real-dsh/artifacts/ (for CI artifacts on failure).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { connect } from 'node:net'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(__dirname, '../..')
const HOST_TARBALL = path.resolve(REPO_ROOT, 'remora-host-1.0.0.tgz')
const RELAY_DIR = path.resolve(REPO_ROOT, 'apps/relay')
const UPSTREAM_LOCK = path.resolve(REPO_ROOT, 'upstream.lock.json')
export const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts')

export const E2E_PROFILE = 'remora-e2e'
/** Seconds the freshly booted dsh must stay alive before we assert on its output. */
export const ALIVE_AFTER_MS = 45_000
/** Seconds dsh gets to exit on SIGTERM before we kill it. */
const TERM_GRACE_MS = 10_000

const IS_WINDOWS = process.platform === 'win32'

/** A chunk of subprocess output: kept raw and as lines for assertions. */
export class OutputLog {
  readonly lines: string[] = []
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
  }

  push(chunk: string | Buffer): void {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) this.lines.push(line)
    }
    try {
      appendFileSync(this.filePath, text)
    } catch {
      // artifact writing must never break the test itself
    }
  }

  get text(): string {
    return this.lines.join('\n')
  }

  /** Last `n` lines, for embedding into assertion messages. */
  tail(n = 60): string {
    return this.lines.slice(-n).join('\n')
  }
}

export function newEnrollSecret(): string {
  return randomBytes(24).toString('base64url')
}

async function findFreePort(): Promise<number> {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'object') {
        resolve(address ? address.port : 0)
      } else {
        resolve(0)
      }
      server.close(() => undefined)
    })
    server.on('error', reject)
  })
}

function quoteArg(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg
}

/** Run a synchronous command; shell only on Windows where .cmd shims need it. */
function runSync(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, IS_WINDOWS ? args.map(quoteArg) : args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout,
    encoding: 'utf8',
    shell: IS_WINDOWS,
    windowsHide: true,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Is the process with this pid still alive? */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface BootOutcome {
  exited: boolean
  exitCode: number | null
}

export class RealDshHarness {
  readonly enrollSecret: string

  relayPort = 0
  dshPort = 0
  relayHttpUrl = ''

  private readonly dshVersion: string
  private readonly logName: (name: string) => string

  private tempInstallDir: string | null = null
  private tempDshHome: string | null = null
  private tempRelayDataDir: string | null = null
  private devVarsBackup: { existed: boolean; content: string } | null = null

  private dshBin: string | null = null
  private relayChild: ChildProcess | null = null
  private dshChild: ChildProcess | null = null
  private readonly relayLog: OutputLog
  private dshBootLog: OutputLog | null = null
  /** Unique markers any surviving process of ours would mention on its command line. */
  private readonly markers: string[] = []

  constructor(options: { enrollSecret: string }) {
    this.enrollSecret = options.enrollSecret
    const lock = JSON.parse(readFileSync(UPSTREAM_LOCK, 'utf8')) as { npmVersion?: string }
    if (!lock.npmVersion) throw new Error(`upstream.lock.json has no npmVersion: ${UPSTREAM_LOCK}`)
    this.dshVersion = lock.npmVersion
    this.logName = (name) => path.join(ARTIFACTS_DIR, name)
    this.relayLog = new OutputLog(this.logName('50-relay.log'))
  }

  // ---------------------------------------------------------------- setup

  /** Remove artifacts from previous runs so uploaded logs belong to this run only. */
  resetArtifacts(): void {
    rmSync(ARTIFACTS_DIR, { recursive: true, force: true })
    mkdirSync(ARTIFACTS_DIR, { recursive: true })
  }

  /**
   * Build @remora/host and its workspace dependencies with the real
   * toolchain (no imports from any package's src): the relay bundles
   * @remora/protocol and @remora/crypto from their built lib/, so the root
   * build must run before anything boots.
   */
  buildHost(): void {
    const log = new OutputLog(this.logName('20-build.log'))
    const res = runSync('pnpm', ['run', 'build'], {
      cwd: REPO_ROOT,
      timeout: 600_000,
    })
    log.push(`pnpm run build -> status ${res.status}\n${res.stdout}\n${res.stderr}`)
    if (res.status !== 0) {
      throw new Error(`pnpm run build failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`)
    }
  }

  /** Install the pinned @deepseek-ai/dsh into a temporary prefix (never global). */
  installDsh(): void {
    const log = new OutputLog(this.logName('10-install-dsh.log'))
    this.tempInstallDir = mkdtempSync(path.join(os.tmpdir(), 'remora-dsh-install-'))
    this.markers.push(this.tempInstallDir)
    const res = runSync(
      'npm',
      [
        'install',
        '--prefix',
        this.tempInstallDir,
        `@deepseek-ai/dsh@${this.dshVersion}`,
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { timeout: 600_000 },
    )
    log.push(`npm install @deepseek-ai/dsh@${this.dshVersion} -> status ${res.status}\n${res.stdout}\n${res.stderr}`)
    if (res.status !== 0) {
      throw new Error(`npm install of pinned dsh@${this.dshVersion} failed (status ${res.status}):\n${res.stdout}\n${res.stderr}`)
    }
    const binName = IS_WINDOWS ? 'dsh.cmd' : 'dsh'
    const bin = path.join(this.tempInstallDir, 'node_modules', '.bin', binName)
    if (!existsSync(bin)) {
      throw new Error(`dsh binary not found after npm install: ${bin}`)
    }
    this.dshBin = bin
    const version = runSync(bin, ['--version'], { timeout: 60_000 })
    log.push(`dsh --version -> ${version.stdout.trim()} ${version.stderr.trim()}`)
    if (version.status !== 0 || !version.stdout.includes(this.dshVersion)) {
      throw new Error(
        `installed dsh reported version "${version.stdout.trim()}" (status ${version.status}), expected ${this.dshVersion}`,
      )
    }
  }

  /** Create a temporary DSH_HOME and initialize the remora-e2e profile from the web template. */
  initProfile(): void {
    if (!this.dshBin) throw new Error('installDsh() must run before initProfile()')
    const log = new OutputLog(this.logName('30-init-profile.log'))
    this.tempDshHome = mkdtempSync(path.join(os.tmpdir(), 'remora-dsh-home-'))
    this.markers.push(this.tempDshHome)
    const res = runSync(
      this.dshBin,
      ['--profile', E2E_PROFILE, '--from-default-profile', 'web', '--dump-config'],
      { cwd: REPO_ROOT, env: this.dshEnv(), timeout: 300_000 },
    )
    log.push(`dsh --from-default-profile web --dump-config -> status ${res.status}\n${res.stdout}\n${res.stderr}`)
    if (res.status !== 0) {
      throw new Error(
        `dsh profile initialization failed (status ${res.status}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      )
    }
  }

  /** Pack @remora/host and install the tarball into the profile (real `dsh plugin add`). */
  addHostPlugin(): void {
    if (!this.dshBin) throw new Error('installDsh() must run before addHostPlugin()')
    const log = new OutputLog(this.logName('40-plugin-add.log'))
    const pack = runSync('pnpm', ['-F', '@remora/host', 'pack'], {
      cwd: REPO_ROOT,
      timeout: 600_000,
    })
    log.push(`pnpm -F @remora/host pack -> status ${pack.status}\n${pack.stdout}\n${pack.stderr}`)
    if (pack.status !== 0) {
      throw new Error(
        `pnpm pack of @remora/host failed (status ${pack.status}):\nstdout:\n${pack.stdout}\nstderr:\n${pack.stderr}`,
      )
    }
    const res = runSync(
      this.dshBin,
      ['plugin', '--profile', E2E_PROFILE, 'add', HOST_TARBALL],
      { cwd: REPO_ROOT, env: this.dshEnv(), timeout: 600_000 },
    )
    log.push(`dsh plugin add ${HOST_TARBALL} -> status ${res.status}\n${res.stdout}\n${res.stderr}`)
    if (res.status !== 0) {
      throw new Error(
        `dsh plugin add failed (status ${res.status}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      )
    }
  }

  /** Start the real relay via `wrangler dev` on a free port with a random test enroll secret. */
  async startRelay(): Promise<void> {
    this.relayPort = await findFreePort()
    this.dshPort = await findFreePort()
    this.relayHttpUrl = `http://127.0.0.1:${this.relayPort}`
    this.tempRelayDataDir = mkdtempSync(path.join(os.tmpdir(), 'remora-relay-data-'))
    this.markers.push(this.tempRelayDataDir)

    this.writeDevVars()

    const npx = IS_WINDOWS ? 'npx.cmd' : 'npx'
    const wranglerArgs = [
      'wrangler',
      'dev',
      '--port',
      String(this.relayPort),
      '--ip',
      '127.0.0.1',
      '--persist-to',
      this.tempRelayDataDir,
    ]
    this.relayChild = spawn(npx, wranglerArgs, {
        cwd: RELAY_DIR,
        env: { ...process.env, REMORA_ENROLL_SECRET: this.enrollSecret, WRANGLER_SEND_METRICS: 'false' },
        shell: IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsHide: true,
      },
    )
    this.relayChild.stdout?.on('data', (chunk: Buffer) => this.relayLog.push(chunk))
    this.relayChild.stderr?.on('data', (chunk: Buffer) => this.relayLog.push(chunk))

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      if (this.relayChild.exitCode !== null) {
        throw new Error(`wrangler dev exited early (${this.relayChild.exitCode}):\n${this.relayLog.tail(80)}`)
      }
      try {
        const res = await fetch(`${this.relayHttpUrl}/v1/health`)
        if (res.ok) {
          const body = (await res.json()) as { ok?: boolean }
          if (body.ok === true) return
        }
      } catch {
        // relay still starting
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`relay /v1/health not ready within 120s:\n${this.relayLog.tail(80)}`)
  }

  /**
   * Point the profile's `remora` row at the local relay. The row replaces the
   * bundle patch's whole config, so every key is restated (see the bundle
   * patch comment and docs/runbooks/operations.md §3).
   */
  writeProfilePatch(): void {
    if (!this.tempDshHome) throw new Error('initProfile() must run before writeProfilePatch()')
    const profileDir = path.join(this.tempDshHome, 'profiles', E2E_PROFILE)
    mkdirSync(profileDir, { recursive: true })
    const patch = [
      '- id: remora',
      '  config:',
      `    relayUrl: '${this.relayHttpUrl}'`,
      "    enrollSecretKey: 'REMORA_RELAY_ENROLL_SECRET'",
      '    remoteRoots: []',
      "    approvalBiometric: 'high'",
      "    approvalAuth: 'biometric'",
      '    approvalTimeoutMs: 3600000',
      '    allowRemoteSessionStart: true',
      "    keepAwake: 'while-busy'",
      '    streamCoalesceMs: 150',
      '    notify:',
      '      approval: true',
      '      question: true',
      '      turnDone: true',
      '      turnError: true',
      '      hostOffline: true',
      '',
    ].join('\n')
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')
  }

  // ------------------------------------------------------------------ dsh

  /** Boot dsh with the remora-e2e profile and collect stdout/stderr. */
  bootDsh(): void {
    if (!this.dshBin) throw new Error('installDsh() must run before bootDsh()')
    const bootIndex = this.dshBootLog === null ? 1 : 2
    this.dshBootLog = new OutputLog(this.logName(`6${bootIndex}-dsh-boot-${bootIndex}.log`))
    this.dshChild = spawn(
      IS_WINDOWS ? quoteArg(this.dshBin) : this.dshBin,
      ['--profile', E2E_PROFILE, '--no-open', '--port', String(this.dshPort)],
      {
        cwd: REPO_ROOT,
        env: this.dshEnv(),
        shell: IS_WINDOWS,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !IS_WINDOWS,
        windowsHide: true,
      },
    )
    const log = this.dshBootLog
    this.dshChild.stdout?.on('data', (chunk: Buffer) => log.push(chunk))
    this.dshChild.stderr?.on('data', (chunk: Buffer) => log.push(chunk))
  }

  /**
   * Wait until dsh either stays alive for `ALIVE_AFTER_MS` or exits early.
   * The collected output stays available via `lastBootOutput`.
   */
  async waitForBoot(): Promise<BootOutcome> {
    const deadline = Date.now() + ALIVE_AFTER_MS
    while (Date.now() < deadline) {
      if (this.dshChild && this.dshChild.exitCode !== null) {
        return { exited: true, exitCode: this.dshChild.exitCode }
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return { exited: false, exitCode: this.dshChild ? this.dshChild.exitCode : null }
  }

  /** Output collected from the most recent dsh boot. */
  get lastBootOutput(): OutputLog | null {
    return this.dshBootLog
  }

  /** Stop dsh: SIGTERM first (where the platform has it), hard kill after the grace period. */
  async stopDsh(graceMs = TERM_GRACE_MS): Promise<void> {
    const child = this.dshChild
    if (!child || child.pid === undefined || child.exitCode !== null) return
    if (!IS_WINDOWS) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    } else {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && pidAlive(child.pid)) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    this.killTree(child)
    this.dshChild = null
  }

  private dshEnv(): NodeJS.ProcessEnv {
    if (!this.tempDshHome) throw new Error('initProfile() must run first')
    return {
      ...process.env,
      DSH_HOME: this.tempDshHome,
      REMORA_RELAY_ENROLL_SECRET: this.enrollSecret,
    }
  }

  // ------------------------------------------------------------- teardown

  private writeDevVars(): void {
    const devVars = path.join(RELAY_DIR, '.dev.vars')
    this.devVarsBackup = existsSync(devVars)
      ? { existed: true, content: readFileSync(devVars, 'utf8') }
      : { existed: false, content: '' }
    writeFileSync(devVars, `REMORA_ENROLL_SECRET="${this.enrollSecret}"\n`, 'utf8')
  }

  private restoreDevVars(): void {
    if (!this.devVarsBackup) return
    const devVars = path.join(RELAY_DIR, '.dev.vars')
    if (this.devVarsBackup.existed) {
      writeFileSync(devVars, this.devVarsBackup.content, 'utf8')
    } else {
      rmSync(devVars, { force: true })
    }
    this.devVarsBackup = null
  }

  /** Kill the whole process tree of a child (POSIX: process group, Windows: taskkill /T). */
  private killTree(child: ChildProcess): void {
    if (!child || child.pid === undefined) return
    if (IS_WINDOWS) {
      const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      })
      if (res.status !== 0 && pidAlive(child.pid)) {
        throw new Error(`taskkill failed for pid ${child.pid}: ${res.stderr ?? res.stdout}`)
      }
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }

  /**
   * Tear everything down and verify nothing survived.
   * @throws when a port is still listening, a tracked pid is still alive, or a
   *   process mentioning one of this run's unique markers still runs.
   */
  async teardown(): Promise<void> {
    const problems: string[] = []
    const trackedPids = [this.dshChild?.pid, this.relayChild?.pid].filter(
      (pid): pid is number => typeof pid === 'number',
    )
    if (this.dshChild) {
      try {
        await this.stopDsh(0)
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
    }
    if (this.relayChild && this.relayChild.pid !== undefined && this.relayChild.exitCode === null) {
      try {
        this.killTree(this.relayChild)
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      }
      this.relayChild = null
    }

    // 1. Nothing left listening on the ports we handed out.
    for (const port of [this.relayPort, this.dshPort]) {
      if (port === 0) continue
      const deadline = Date.now() + 15_000
      let open = true
      while (Date.now() < deadline) {
        open = await portOpen(port)
        if (!open) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      if (open) problems.push(`port ${port} is still listening after teardown`)
    }

    // 2. Tracked children are gone.
    for (const pid of trackedPids) {
      if (pidAlive(pid)) {
        this.killPid(pid)
        if (pidAlive(pid)) problems.push(`tracked process pid ${pid} is still alive after teardown`)
      }
    }

    // 3. No stray process mentioning this run's unique paths/ports.
    const strays = this.findStrayProcesses()
    if (strays.length > 0) {
      problems.push(`stray processes from this test survived: ${strays.join('; ')}`)
      for (const stray of strays) {
        const pid = Number(/pid (\d+)/.exec(stray)?.[1])
        if (Number.isInteger(pid)) this.killPid(pid)
      }
    }

    this.restoreDevVars()
    for (const dir of [this.tempDshHome, this.tempRelayDataDir, this.tempInstallDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
    this.tempDshHome = null
    this.tempRelayDataDir = null
    this.tempInstallDir = null

    if (problems.length > 0) throw new Error(`teardown verification failed:\n- ${problems.join('\n- ')}`)
  }

  /** Processes whose command line mentions one of this run's unique markers. */
  private findStrayProcesses(): string[] {
    if (this.markers.length === 0) return []
    const strays: string[] = []
    if (IS_WINDOWS) {
      // No double quotes in the -Command string: node's argv quoting for
      // powershell.exe only escapes double quotes, and PS 5.1 parses them
      // inconsistently. Single quotes survive verbatim.
      const res = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and (${
            this.markers.map((marker) => `$_.CommandLine -like '*${marker.replaceAll("'", "''")}*'`).join(' -or ')
          }) } | ForEach-Object { Write-Output ('pid ' + $_.ProcessId + ' ' + $_.Name + ' ' + $_.CommandLine) }`,
        ],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true },
      )
      for (const line of (res.stdout ?? '').split(/\r?\n/)) {
        const trimmed = line.trim()
        // Skip the scan's own process: its command line contains the markers.
        if (trimmed.startsWith('pid ') && !trimmed.includes('Get-CimInstance Win32_Process')) {
          strays.push(trimmed)
        }
      }
    } else {
      const res = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 30_000 })
      for (const line of (res.stdout ?? '').split('\n')) {
        if (this.markers.some((marker) => line.includes(marker))) strays.push(line.trim())
      }
    }
    return strays
  }

  private killPid(pid: number): void {
    if (IS_WINDOWS) {
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
    } else {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      resolve(false)
    })
  })
}
