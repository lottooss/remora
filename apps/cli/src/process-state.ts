import fs from 'node:fs'
import path from 'node:path'
import { getAppDataDir } from './paths.ts'
import { validateTaskName } from './options.ts'

/** Every service instance owns a separate directory; it contains no credentials. */
export function getServiceDir(taskName: string = 'RemoraHost'): string {
  return path.join(getAppDataDir(), 'services', validateTaskName(taskName))
}

/** Check liveness only. Never send a terminating signal to a persisted PID. */
export function supervisorIsAlive(taskName: string): boolean {
  const statePath = path.join(getServiceDir(taskName), 'supervisor.json')
  if (!fs.existsSync(statePath)) return false
  try {
    const state: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    if (typeof state !== 'object' || state === null || !('pid' in state) ||
        typeof state.pid !== 'number' || !Number.isSafeInteger(state.pid) || state.pid <= 0) return true
    process.kill(state.pid, 0)
    return true
  } catch (error: unknown) {
    // A corrupt/in-progress state or denied query is not permission to start a duplicate.
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
  }
}
