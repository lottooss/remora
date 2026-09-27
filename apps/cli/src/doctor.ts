import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { getDshProfileDir } from './paths.ts'

export interface DoctorCheck {
  name: string
  status: 'pass' | 'warn' | 'fail'
  message: string
  hint?: string
}

export interface DoctorReport {
  overallSuccess: boolean
  checks: DoctorCheck[]
}

export async function checkNodeVersion(): Promise<DoctorCheck> {
  const version = process.versions.node
  const major = parseInt(version.split('.')[0] ?? '0', 10)
  if (major >= 24) {
    return {
      name: 'Node.js runtime',
      status: 'pass',
      message: `v${version} (meets >= 24 requirement)`,
    }
  }
  return {
    name: 'Node.js runtime',
    status: 'fail',
    message: `v${version} is unsupported; Node >= 24 required`,
    hint: 'Install Node 24+ via fnm, nvm-windows, or official installer.',
  }
}

export async function checkDshInstalled(): Promise<DoctorCheck> {
  try {
    const versionOutput = execSync('dsh --version', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    return {
      name: 'DeepSeek Harness (dsh)',
      status: 'pass',
      message: `dsh CLI found: ${versionOutput}`,
    }
  } catch {
    return {
      name: 'DeepSeek Harness (dsh)',
      status: 'warn',
      message: 'dsh command not found on PATH',
      hint: 'Install dsh globally via `npm install -g @deepseek-ai/dsh` or ensure it is on PATH.',
    }
  }
}

export async function checkProfilePresent(profile: string = 'remora'): Promise<DoctorCheck> {
  const profileDir = getDshProfileDir(profile)
  if (fs.existsSync(profileDir)) {
    return {
      name: `dsh profile '${profile}'`,
      status: 'pass',
      message: `Profile exists at ${profileDir}`,
    }
  }
  return {
    name: `dsh profile '${profile}'`,
    status: 'warn',
    message: `Profile directory not found: ${profileDir}`,
    hint: `Create profile via \`dsh --profile ${profile} --from-default-profile web\``,
  }
}

export async function checkBundleInstalled(profile: string = 'remora'): Promise<DoctorCheck> {
  const profileDir = getDshProfileDir(profile)
  const patchYml = path.join(profileDir, 'cordis.patch.yml')
  if (!fs.existsSync(patchYml)) {
    return {
      name: 'Remora host bundle',
      status: 'warn',
      message: 'cordis.patch.yml not found in profile',
      hint: `Add plugin via \`dsh plugin --profile ${profile} add ./packages/host\``,
    }
  }
  const content = fs.readFileSync(patchYml, 'utf8')
  if (content.includes('remora') || content.includes('@remora/host')) {
    return {
      name: 'Remora host bundle',
      status: 'pass',
      message: 'Remora plugin configured in cordis.patch.yml',
    }
  }
  return {
    name: 'Remora host bundle',
    status: 'warn',
    message: 'Remora row missing in cordis.patch.yml',
    hint: 'Configure remora row in cordis.patch.yml per docs/runbooks/operations.md §3.',
  }
}

export async function checkRelayReachable(relayUrl?: string): Promise<DoctorCheck> {
  const target = relayUrl || 'https://127.0.0.1:8787'
  try {
    const res = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(3000) })
    return {
      name: 'Relay reachability',
      status: 'pass',
      message: `Reachable (${target} responded with HTTP ${res.status})`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'connection refused'
    return {
      name: 'Relay reachability',
      status: 'warn',
      message: `Could not reach relay at ${target}: ${msg}`,
      hint: 'Verify relay deployment with `pnpm -F @remora/relay run dev` or check your Cloudflare Worker URL.',
    }
  }
}

export async function checkServiceState(): Promise<DoctorCheck> {
  if (process.platform === 'win32') {
    try {
      const output = execSync('schtasks /Query /TN RemoraHost', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (output.includes('RemoraHost')) {
        return {
          name: 'Logon service',
          status: 'pass',
          message: 'Scheduled task RemoraHost is registered',
        }
      }
    } catch {
      // not found
    }
    return {
      name: 'Logon service',
      status: 'warn',
      message: 'RemoraHost scheduled task not found',
      hint: 'Run `remora service install` to register logon autostart.',
    }
  }
  return {
    name: 'Logon service',
    status: 'pass',
    message: `Service management available on ${process.platform}`,
  }
}

export async function checkKeepAwakeSupport(): Promise<DoctorCheck> {
  const p = process.platform
  if (p === 'win32' || p === 'darwin' || p === 'linux') {
    return {
      name: 'Keep-awake support',
      status: 'pass',
      message: `Native keep-awake supported on ${p}`,
    }
  }
  return {
    name: 'Keep-awake support',
    status: 'warn',
    message: `Platform ${p} uses no-op keep-awake fallback`,
  }
}

export function checkPowerSettingsHints(): DoctorCheck {
  return {
    name: 'Power settings advice',
    status: 'pass',
    message: 'PC can be locked (Win+L). For 24/7 availability on laptops, set "When I close lid" to "Do nothing".',
  }
}

export async function runDoctor(profile: string = 'remora', relayUrl?: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    await checkNodeVersion(),
    await checkDshInstalled(),
    await checkProfilePresent(profile),
    await checkBundleInstalled(profile),
    await checkRelayReachable(relayUrl),
    await checkServiceState(),
    await checkKeepAwakeSupport(),
    checkPowerSettingsHints(),
  ]

  const overallSuccess = !checks.some((c) => c.status === 'fail')
  return { overallSuccess, checks }
}

export function printDoctorReport(report: DoctorReport): void {
  console.log('\n=== remora doctor ===\n')
  for (const check of report.checks) {
    const symbol = check.status === 'pass' ? '[\x1b[32m✓\x1b[0m]' : check.status === 'warn' ? '[\x1b[33m!\x1b[0m]' : '[\x1b[31m✗\x1b[0m]'
    console.log(`${symbol} ${check.name}: ${check.message}`)
    if (check.hint) {
      console.log(`    Hint: ${check.hint}`)
    }
  }
  console.log('')
  if (report.overallSuccess) {
    console.log('\x1b[32mDoctor found no critical failures.\x1b[0m')
  } else {
    console.log('\x1b[31mDoctor found one or more critical issues. See hints above.\x1b[0m')
  }
}
