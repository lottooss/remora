import fs from 'node:fs'
import path from 'node:path'
import { getDshProfileDir } from './paths.ts'
import { PINNED_DSH_VERSION, resolveDshRuntime } from './runtime.ts'
import { getServiceStatus } from './service.ts'

export interface DoctorCheck { name: string; status: 'pass' | 'warn' | 'fail'; message: string; hint?: string }
export interface DoctorReport { overallSuccess: boolean; checks: DoctorCheck[] }

/** Report local Node compatibility without launching another process. */
export async function checkNodeVersion(): Promise<DoctorCheck> {
  const valid = Number(process.versions.node.split('.')[0]) >= 24
  return { name: 'Node.js runtime', status: valid ? 'pass' : 'fail', message: `v${process.versions.node}; Node >= 24 required.` }
}

/** Check the same pinned runtime used by the supervisor, never an unrelated PATH binary. */
export async function checkDshInstalled(): Promise<DoctorCheck> {
  try {
    resolveDshRuntime()
    return { name: 'Dedicated dsh runtime', status: 'pass', message: `@deepseek-ai/dsh@${PINNED_DSH_VERSION} is installed.` }
  } catch {
    return { name: 'Dedicated dsh runtime', status: 'fail', message: 'The pinned runtime is missing or does not match this release.', hint: 'Follow operations.md section 3; a global dsh installation is not the service runtime.' }
  }
}

/** Only existence is checked; no credential or profile content is printed. */
export async function checkProfilePresent(profile: string = 'remora'): Promise<DoctorCheck> {
  return fs.existsSync(getDshProfileDir(profile))
    ? { name: 'dsh profile', status: 'pass', message: `Dedicated profile ${profile} exists.` }
    : { name: 'dsh profile', status: 'fail', message: `Dedicated profile ${profile} is missing.`, hint: 'Create it using the pinned dsh runtime before installing the service.' }
}

/** A config row is a hint, not proof that Cordis loaded a working host. */
export async function checkBundleInstalled(profile: string = 'remora'): Promise<DoctorCheck> {
  const patch = path.join(getDshProfileDir(profile), 'cordis.patch.yml')
  try {
    if (fs.statSync(patch).size > 256 * 1024) throw new Error('Oversized patch')
    const content = fs.readFileSync(patch, 'utf8')
    if (!/^\s*-\s*id:\s*['"]?remora['"]?\s*(?:#.*)?$/m.test(content)) throw new Error('Missing row')
    return { name: 'Remora host bundle', status: 'warn', message: 'Remora configuration row exists; live plugin startup has not been inspected.', hint: 'Confirm the app connects to this host before relying on unattended operation.' }
  } catch {
    return { name: 'Remora host bundle', status: 'fail', message: 'Remora configuration row is absent or unreadable.', hint: 'Install the packed host with --allow-build koffi and configure its profile as described in operations.md section 3.' }
  }
}

/** Require the RLY/1 health body, not merely an arbitrary HTTP response. */
export async function checkRelayReachable(relayUrl?: string): Promise<DoctorCheck> {
  if (relayUrl === undefined) return { name: 'Relay health', status: 'warn', message: 'No relay URL supplied; network health was not checked.', hint: 'Pass --relay-url https://<your-relay>.' }
  try {
    const url = new URL(relayUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid relay URL')
    const response = await fetch(new URL('/v1/health', url), { signal: AbortSignal.timeout(5000), redirect: 'error' })
    if (!response.ok || response.body === null) throw new Error('Unhealthy relay')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        length += next.value.byteLength
        if (length > 1024) throw new Error('Oversized response')
        chunks.push(next.value)
      }
    } finally { await reader.cancel() }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof body !== 'object' || body === null || !('ok' in body) || body.ok !== true || !('v' in body) || body.v !== 1) throw new Error('Wrong protocol')
    return { name: 'Relay health', status: 'pass', message: 'HTTPS /v1/health returned RLY/1 readiness.' }
  } catch {
    return { name: 'Relay health', status: 'fail', message: 'Relay HTTPS health check failed or returned an invalid response.', hint: 'Use the relay HTTPS origin without credentials, query or path; check the owner deployment and network.' }
  }
}

/** Include the documented HKCU fallback, without printing registry/task command strings. */
export async function checkServiceState(taskName: string = 'RemoraHost'): Promise<DoctorCheck> {
  const state = getServiceStatus(taskName)
  return { name: 'Logon supervisor', status: state.registered && state.running ? 'pass' : 'warn', message: `${state.details} Supervisor ${state.running ? 'present (or state needs attention)' : 'stopped'}; relay connection is not inferred from this.` }
}

/** Platform capability only; the host reports actual acquisition independently. */
export async function checkKeepAwakeSupport(): Promise<DoctorCheck> {
  return { name: 'Keep-awake support', status: ['win32', 'darwin', 'linux'].includes(process.platform) ? 'pass' : 'warn', message: `Native keep-awake supported on Windows, macOS and Linux. Active acquisition must be confirmed in host status.` }
}

/** Keep explicit sleep and lid policies under the owner's control. */
export function checkPowerSettingsHints(): DoctorCheck {
  return { name: 'Power settings advice', status: 'pass', message: 'A locked PC (Win+L) can stay online. Lid-close, explicit sleep and battery policies still apply.' }
}

/** Read local setup facts and, only when supplied, the relay's public health endpoint. */
export async function runDoctor(profile: string = 'remora', relayUrl?: string, taskName: string = 'RemoraHost'): Promise<DoctorReport> {
  const checks = [await checkNodeVersion(), await checkDshInstalled(), await checkProfilePresent(profile), await checkBundleInstalled(profile), await checkRelayReachable(relayUrl), await checkServiceState(taskName), await checkKeepAwakeSupport(), checkPowerSettingsHints()]
  return { overallSuccess: !checks.some((check) => check.status === 'fail'), checks }
}

/** Diagnostics contain fixed status messages and never subprocess output or credentials. */
export function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.name}: ${check.message}`)
    if (check.hint !== undefined) console.log(`  ${check.hint}`)
  }
  console.log(report.overallSuccess ? 'No local blocking failures found; warnings and owner acceptance remain open.' : 'Fix the reported failures before relying on the service.')
}
