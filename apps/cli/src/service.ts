import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { getDailyLogPath, getDshHomeDir } from './paths.ts'
import { getServiceDir, supervisorIsAlive } from './process-state.ts'
import { PINNED_DSH_VERSION, resolveDshRuntime } from './runtime.ts'
import { CliUsageError, validatePort, validateProfile, validateTaskName } from './options.ts'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
type ServiceResult = { success: boolean; message: string }
export interface ServiceInstallOptions {
  dshVersion?: string | undefined
  port?: number | undefined
  profile?: string | undefined
  taskName?: string | undefined
}
export interface ServiceConfig {
  profile: string
  port: number
  taskName: string
  dshHome: string
}

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Windows command-line quoting, consumed by conhost/CreateProcess rather than cmd.exe. */
function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, '$&$&')}"`
}

function run(executable: string, args: string[]): string {
  return execFileSync(executable, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024,
  }).trim()
}

function succeeds(executable: string, args: string[]): boolean {
  try { run(executable, args); return true } catch { return false }
}

/** Read the bounded, non-secret install snapshot; paths never come from shell expansion. */
export function readServiceConfig(taskName: string = 'RemoraHost'): ServiceConfig {
  const file = path.join(getServiceDir(taskName), 'config.json')
  if (fs.statSync(file).size > 16 * 1024) throw new CliUsageError('Invalid service configuration.')
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof value !== 'object' || value === null ||
      !('profile' in value) || typeof value.profile !== 'string' ||
      !('port' in value) || typeof value.port !== 'number' ||
      !('taskName' in value) || value.taskName !== taskName ||
      !('dshHome' in value) || typeof value.dshHome !== 'string' || !path.isAbsolute(value.dshHome) ||
      /[\r\n\0]/.test(value.dshHome)) throw new CliUsageError('Invalid service configuration.')
  return { profile: validateProfile(value.profile), port: validatePort(value.port), taskName: validateTaskName(taskName), dshHome: value.dshHome }
}

/** Install a per-user Windows task, falling back to the documented HKCU Run entry. */
export function installService(options: ServiceInstallOptions = {}): ServiceResult {
  const profile = validateProfile(options.profile ?? 'remora')
  const port = validatePort(options.port ?? 7717)
  const taskName = validateTaskName(options.taskName ?? 'RemoraHost')
  if (process.platform !== 'win32') return { success: false, message: 'Automated service installation is supported on Windows. Use remora host run with your user service manager on this platform.' }
  resolveDshRuntime(options.dshVersion ?? PINNED_DSH_VERSION)
  if (supervisorIsAlive(taskName)) return { success: false, message: 'Stop the existing supervisor before installing or upgrading.' }
  const dshHome = getDshHomeDir()
  if (!fs.existsSync(path.join(dshHome, 'profiles', profile, 'cordis.patch.yml'))) {
    return { success: false, message: 'Create and configure the dedicated Remora profile before installing its service.' }
  }
  const sourceDir = path.dirname(fileURLToPath(import.meta.url))
  if (!fs.existsSync(path.join(sourceDir, 'bin.js'))) return { success: false, message: 'Build and run the compiled CLI before installing its service.' }
  const directory = getServiceDir(taskName)
  const cliDir = path.join(directory, 'cli')
  const destination = path.join(cliDir, 'lib')
  fs.mkdirSync(destination, { recursive: true })
  // An installed copy may reinstall itself without copying a file over itself.
  if (path.resolve(sourceDir) !== path.resolve(destination)) {
    fs.cpSync(sourceDir, destination, { recursive: true, force: true })
    fs.copyFileSync(path.join(sourceDir, '..', 'package.json'), path.join(cliDir, 'package.json'))
  }
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ profile, port, taskName, dshHome }), { mode: 0o600 })
  const cliBin = path.join(destination, 'bin.js')
  const args = [process.execPath, cliBin, 'host', 'run', '--installed-task', taskName].map(windowsArgument).join(' ')
  const conhost = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe')
  const script = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute ${psLiteral(conhost)} -Argument ${psLiteral(`--headless ${args}`)} -WorkingDirectory ${psLiteral(dshHome)}
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${psLiteral(taskName)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`
  try {
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])
    // Remove a previous fallback so a logon cannot start the supervisor twice.
    if (succeeds('reg.exe', ['query', RUN_KEY, '/v', taskName]) && !succeeds('reg.exe', ['delete', RUN_KEY, '/v', taskName, '/f'])) {
      return { success: false, message: 'Task registered, but the prior Run entry could not be removed. Remove the duplicate before starting.' }
    }
    return { success: true, message: `Registered per-user task ${taskName}. Start with remora service start --task-name ${taskName}, or sign out and back in.` }
  } catch {
    // Never create a second autostart if a prior scheduler task still exists.
    if (succeeds('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])) {
      return { success: false, message: 'Could not update the existing scheduled task. Uninstall it before retrying.' }
    }
    if (succeeds('reg.exe', ['add', RUN_KEY, '/v', taskName, '/t', 'REG_SZ', '/d', `${windowsArgument(conhost)} --headless ${args}`, '/f'])) {
      return { success: true, message: `Registered HKCU Run entry ${taskName}. Start with remora service start --task-name ${taskName}, or sign out and back in.` }
    }
    return { success: false, message: 'Windows denied both per-user autostart methods. No elevation is requested; consult your device administrator.' }
  }
}

/** Report registration separately from process liveness; this does not assert relay health. */
export function getServiceStatus(taskName: string = 'RemoraHost'): { registered: boolean; running: boolean; details: string } {
  validateTaskName(taskName)
  const running = supervisorIsAlive(taskName)
  if (process.platform !== 'win32') return { registered: false, running, details: 'Automated registration is Windows-only.' }
  const scheduled = succeeds('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])
  const fallback = succeeds('reg.exe', ['query', RUN_KEY, '/v', taskName])
  return {
    registered: scheduled || fallback, running,
    details: scheduled && fallback ? 'Both scheduled task and HKCU Run entry exist; reinstall to remove the duplicate.'
      : scheduled ? 'Task Scheduler registration.' : fallback ? 'HKCU Run registration.' : 'No autostart registration.',
  }
}

/** Start a registered service without requiring a new login. */
export async function startService(taskName: string = 'RemoraHost'): Promise<ServiceResult> {
  if (process.platform !== 'win32') return { success: false, message: 'Use remora host run on this platform.' }
  const status = getServiceStatus(taskName)
  if (!status.registered) return { success: false, message: 'Install the service before starting it.' }
  if (status.running) return { success: true, message: 'Supervisor is already running.' }
  const config = readServiceConfig(taskName)
  resolveDshRuntime()
  fs.rmSync(path.join(getServiceDir(taskName), 'stop-request'), { force: true })
  if (succeeds('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])) {
    if (!succeeds('schtasks.exe', ['/Run', '/TN', taskName])) return { success: false, message: 'Windows could not start the scheduled task.' }
  } else {
    const child = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe'), [
      '--headless', process.execPath, path.join(getServiceDir(taskName), 'cli', 'lib', 'bin.js'), 'host', 'run', '--installed-task', taskName,
    ], { cwd: config.dshHome, stdio: 'ignore', windowsHide: true, detached: true, shell: false })
    const started = await new Promise<boolean>((resolve) => {
      child.once('spawn', () => resolve(true))
      child.once('error', () => resolve(false))
    })
    child.unref()
    if (!started) return { success: false, message: 'Windows could not launch the supervisor.' }
  }
  for (let attempt = 0; attempt < 25; attempt++) {
    await delay(200)
    if (supervisorIsAlive(taskName)) return { success: true, message: 'Supervisor started. Use the app to confirm relay connectivity.' }
  }
  return { success: false, message: 'Supervisor did not report startup. Check the installed runtime, profile and lifecycle logs.' }
}

/** Ask the live supervisor to stop its owned child and wait for acknowledgement. */
export async function stopService(taskName: string = 'RemoraHost'): Promise<ServiceResult> {
  const directory = getServiceDir(taskName)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'stop-request'), '', { mode: 0o600 })
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!supervisorIsAlive(taskName)) return { success: true, message: 'Supervisor stopped.' }
    await delay(200)
  }
  return { success: false, message: 'Supervisor did not acknowledge stop. Inspect the owned process before retrying; no stored PID was terminated.' }
}

/** Remove autostart entries and await child shutdown; retain runtime, logs and user data. */
export async function uninstallService(taskName: string = 'RemoraHost'): Promise<ServiceResult> {
  validateTaskName(taskName)
  if (process.platform !== 'win32') return { success: false, message: 'Remove the entry from your user service manager, then use remora service stop.' }
  const scheduled = succeeds('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])
  const fallback = succeeds('reg.exe', ['query', RUN_KEY, '/v', taskName])
  if (scheduled && !succeeds('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])) return { success: false, message: 'Windows could not remove the scheduled task.' }
  if (fallback && !succeeds('reg.exe', ['delete', RUN_KEY, '/v', taskName, '/f'])) return { success: false, message: 'Windows could not remove the HKCU Run entry.' }
  const stopped = await stopService(taskName)
  if (!stopped.success) return stopped
  if (getServiceStatus(taskName).registered) return { success: false, message: 'An autostart entry remains registered; uninstall is incomplete.' }
  return { success: true, message: 'Autostart removed and supervisor stopped. Runtime, CLI snapshot, logs and dsh profile are retained.' }
}

/** Tail a bounded portion of lifecycle logs; following also handles midnight and truncation. */
export function printLogs(follow: boolean = false, taskName: string = 'RemoraHost'): void {
  validateTaskName(taskName)
  let currentPath = ''
  let offset = 0
  const read = () => {
    const logPath = getDailyLogPath(new Date(), taskName)
    try {
      const size = fs.statSync(logPath).size
      if (currentPath !== logPath || size < offset) { currentPath = logPath; offset = Math.max(0, size - 64 * 1024) }
      const length = Math.min(64 * 1024, size - offset)
      if (length <= 0) return
      const file = fs.openSync(logPath, 'r')
      try {
        const bytes = Buffer.alloc(length)
        const count = fs.readSync(file, bytes, 0, length, offset)
        offset += count
        process.stdout.write(bytes.subarray(0, count))
      } finally { fs.closeSync(file) }
    } catch { /* A missing log is normal before the first launch and at midnight. */ }
  }
  read()
  if (currentPath === '') console.log('No lifecycle logs yet.')
  if (follow) setInterval(read, 1000)
}
