/**
 * E2eEnvironment: manages local relay (wrangler dev), mock LLM server,
 * and a real dsh process running with an isolated DSH_HOME and the Remora bundle.
 * Guaranteed teardown cleans up all processes, ports, and temp directories.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockLlmServer } from './mock-llm.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const RELAY_DIR = path.resolve(REPO_ROOT, 'apps/relay')
const HOST_PKG_DIR = path.resolve(REPO_ROOT, 'packages/host')

export const E2E_PROFILE = 'remora-e2e'
export const DEFAULT_ENROLL_SECRET = 'test-enroll-secret'

export interface E2eEnvironmentOptions {
  relayPort?: number
  dshPort?: number
  mockLlmPort?: number
  enrollSecret?: string
  useRealDsh?: boolean
}

export interface E2eProcessLogs {
  relayStdout: string
  relayStderr: string
  dshStdout: string
  dshStderr: string
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

function killProcessTree(child: ChildProcess): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
    } catch {
      // ignore
    }
  } else {
    try {
      child.kill('SIGKILL')
    } catch {
      // ignore
    }
  }
}

export class E2eEnvironment {
  readonly enrollSecret: string
  readonly useRealDsh: boolean

  mockLlm: MockLlmServer | null = null
  relayChild: ChildProcess | null = null
  dshChild: ChildProcess | null = null
  tempDshHome: string | null = null
  tempRelayDir: string | null = null

  relayPort = 0
  dshPort = 0
  relayHttpUrl = ''
  relayWsUrl = ''

  private relayOut: string[] = []
  private relayErr: string[] = []
  private dshOut: string[] = []
  private dshErr: string[] = []

  constructor(options: E2eEnvironmentOptions = {}) {
    this.enrollSecret = options.enrollSecret ?? DEFAULT_ENROLL_SECRET
    this.useRealDsh = options.useRealDsh ?? true
    if (options.relayPort) this.relayPort = options.relayPort
    if (options.dshPort) this.dshPort = options.dshPort
  }

  get logs(): E2eProcessLogs {
    return {
      relayStdout: this.relayOut.join(''),
      relayStderr: this.relayErr.join(''),
      dshStdout: this.dshOut.join(''),
      dshStderr: this.dshErr.join(''),
    }
  }

  async start(): Promise<void> {
    try {
      if (!this.relayPort) this.relayPort = await findFreePort()
      if (!this.dshPort) this.dshPort = await findFreePort()

      // 1. Start Mock LLM
      this.mockLlm = new MockLlmServer()
      await this.mockLlm.start()

      // 2. Start Relay (Wrangler dev)
      this.tempRelayDir = mkdtempSync(path.join(os.tmpdir(), 'remora-relay-e2e-'))
      this.relayHttpUrl = `http://127.0.0.1:${this.relayPort}`
      this.relayWsUrl = `ws://127.0.0.1:${this.relayPort}/v1/connect`
      await this.startRelay()

      // 3. Start DSH if requested and available
      if (this.useRealDsh) {
        await this.startDsh()
      }
    } catch (err) {
      await this.teardown()
      throw err
    }
  }

  private async startRelay(): Promise<void> {
    const isWindows = process.platform === 'win32'
    const npxCmd = isWindows ? 'npx.cmd' : 'npx'

    const args = ['wrangler', 'dev', '--port', String(this.relayPort), '--ip', '127.0.0.1']
    if (this.tempRelayDir) {
      args.push('--persist-to', this.tempRelayDir)
    }

    this.relayChild = spawn(
      npxCmd,
      args,
      {
        cwd: RELAY_DIR,
        env: {
          ...process.env,
          REMORA_ENROLL_SECRET: this.enrollSecret,
        },
        shell: isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.relayChild.stdout?.on('data', (d) => {
      this.relayOut.push(String(d))
    })
    this.relayChild.stderr?.on('data', (d) => {
      this.relayErr.push(String(d))
    })

    // Poll until /v1/health responds
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.relayHttpUrl}/v1/health`)
        if (res.ok) {
          const body = (await res.json()) as any
          if (body?.ok === true) return
        }
      } catch {
        // still starting
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`Relay failed to start within 30s. Logs:\n${this.relayErr.join('')}\n${this.relayOut.join('')}`)
  }

  private findDshBin(): string | null {
    // Check known local dsh bin locations
    const localBin = path.resolve(REPO_ROOT, 'spikes/p0-s2-answer-bridge/.install/node_modules/.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
    if (existsSync(localBin)) return localBin

    // Check system PATH
    const whereRes = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['dsh'], { encoding: 'utf8' })
    if (whereRes.status === 0 && whereRes.stdout.trim()) {
      return whereRes.stdout.trim().split('\n')[0]!.trim()
    }
    return null
  }

  private async startDsh(): Promise<void> {
    const dshBin = this.findDshBin()
    if (!dshBin) {
      throw new Error('dsh executable not found. Make sure dsh is available in PATH or spikes/.install.')
    }

    // Create isolated temporary DSH_HOME
    this.tempDshHome = mkdtempSync(path.join(os.tmpdir(), 'remora-dsh-e2e-'))

    const isWindows = process.platform === 'win32'

    // Create profile remora-e2e from web template
    const initRes = spawnSync(
      dshBin,
      ['--profile', E2E_PROFILE, '--from-default-profile', 'web', '--dump-config'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DSH_HOME: this.tempDshHome },
        shell: isWindows,
        encoding: 'utf8',
      },
    )
    if (initRes.status !== 0) {
      throw new Error(`Failed to initialize dsh profile: ${initRes.stderr || initRes.stdout}`)
    }

    // Add Remora host plugin to profile
    const addRes = spawnSync(
      dshBin,
      ['plugin', '--profile', E2E_PROFILE, 'add', HOST_PKG_DIR],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, DSH_HOME: this.tempDshHome },
        shell: isWindows,
        encoding: 'utf8',
      },
    )
    if (addRes.status !== 0) {
      throw new Error(`Failed to add host bundle to dsh profile: ${addRes.stderr || addRes.stdout}`)
    }

    // Write profile's cordis.patch.yml to configure relayUrl
    const profileDir = path.join(this.tempDshHome, 'profiles', E2E_PROFILE)
    mkdirSync(profileDir, { recursive: true })
    const patchYaml = [
      '- id: remora',
      '  config:',
      `    relayUrl: '${this.relayHttpUrl}'`,
      `    enrollSecretKey: 'REMORA_RELAY_ENROLL_SECRET'`,
      '    remoteRoots: []',
      `    approvalBiometric: 'high'`,
      `    approvalAuth: 'biometric'`,
      '    approvalTimeoutMs: 3600000',
      '    allowRemoteSessionStart: true',
      `    keepAwake: 'while-busy'`,
      '    streamCoalesceMs: 150',
      '    notify:',
      '      approval: true',
      '      question: true',
      '      turnDone: true',
      '      turnError: true',
      '      hostOffline: true',
    ].join('\n')
    writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patchYaml, 'utf8')

    // Spawn dsh runner
    this.dshChild = spawn(
      dshBin,
      ['--profile', E2E_PROFILE, '--no-open', '--port', String(this.dshPort)],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DSH_HOME: this.tempDshHome,
          DEEPSEEK_BASE_URL: this.mockLlm!.baseURL,
          DEEPSEEK_API_KEY: this.mockLlm!.apiKey,
          REMORA_RELAY_ENROLL_SECRET: this.enrollSecret,
        },
        shell: isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    this.dshChild.stdout?.on('data', (d) => {
      this.dshOut.push(String(d))
    })
    this.dshChild.stderr?.on('data', (d) => {
      this.dshErr.push(String(d))
    })

    // Poll until dsh web is ready
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (this.dshOut.some((l) => l.includes('dsh web:') || l.includes('remora: host started'))) {
        return
      }
      if (this.dshChild.exitCode !== null) {
        throw new Error(`dsh exited early (${this.dshChild.exitCode}):\n${this.dshErr.join('')}\n${this.dshOut.join('')}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error(`dsh failed to start within 30s. Logs:\n${this.dshErr.join('')}\n${this.dshOut.join('')}`)
  }

  async teardown(): Promise<void> {
    if (this.dshChild) {
      killProcessTree(this.dshChild)
      this.dshChild = null
    }

    if (this.relayChild) {
      killProcessTree(this.relayChild)
      this.relayChild = null
    }

    if (this.mockLlm) {
      await this.mockLlm.close()
      this.mockLlm = null
    }

    if (this.tempDshHome && existsSync(this.tempDshHome)) {
      try {
        rmSync(this.tempDshHome, { recursive: true, force: true })
      } catch {
        // ignore
      }
      this.tempDshHome = null
    }

    if (this.tempRelayDir && existsSync(this.tempRelayDir)) {
      try {
        rmSync(this.tempRelayDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
      this.tempRelayDir = null
    }
  }
}
