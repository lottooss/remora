import fs from 'node:fs'
import { installService, uninstallService, getServiceStatus, printLogs, startService, stopService, readServiceConfig } from './service.ts'
import { HostSupervisor } from './supervisor.ts'
import { runDoctor, printDoctorReport } from './doctor.ts'
import { CliUsageError, parseOptions, validatePort, validateProfile, validateTaskName } from './options.ts'

const USAGE = `remora — keep the Remora host running on this PC

Usage:
  remora service install [--dsh-version <v>] [--port 7717] [--profile remora] [--task-name RemoraHost]
  remora service start | stop | uninstall | status [--task-name RemoraHost]
  remora service logs [-f] [--task-name RemoraHost]
  remora host run [--port 7717] [--profile remora] [--task-name RemoraHost]
  remora doctor [--profile remora] [--relay-url https://<relay>] [--task-name RemoraHost]
  remora --help | --version

Install the pinned dsh runtime first; see docs/runbooks/operations.md section 3.
Service installation snapshots DSH_HOME and the compiled CLI; it stores no secrets.`

function version(): string {
  const value: unknown = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (typeof value !== 'object' || value === null || !('version' in value) || typeof value.version !== 'string') {
    throw new Error('Invalid package manifest')
  }
  return value.version
}

function portOption(options: Map<string, string>): number {
  const port = options.get('--port') ?? '7717'
  if (!/^\d{1,5}$/.test(port)) throw new CliUsageError('Port must be an integer between 1 and 65535.')
  return validatePort(Number(port))
}

/** Dispatch explicit CLI operations; option validation precedes every side effect. */
export async function mainAsync(argv: readonly string[]): Promise<number> {
  try {
    const [command, subcommand] = argv
    if (command === undefined || command === '--help' || command === '-h' || command === '--version') {
      if (argv.length > 1) throw new CliUsageError('Unexpected arguments.')
      console.log(command === '--version' ? version() : USAGE)
      return 0
    }
    if (command === 'service') {
      const values = subcommand === 'install' ? ['--dsh-version', '--port', '--profile', '--task-name'] : ['--task-name']
      const options = parseOptions(argv.slice(2), values, subcommand === 'logs' ? ['-f'] : [])
      const taskName = validateTaskName(options.get('--task-name') ?? 'RemoraHost')
      if (subcommand === 'install') {
        const result = installService({ port: portOption(options), profile: validateProfile(options.get('--profile') ?? 'remora'), taskName, dshVersion: options.get('--dsh-version') })
        console.log(result.message)
        return result.success ? 0 : 1
      }
      if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'uninstall') {
        const result = await (subcommand === 'start' ? startService(taskName) : subcommand === 'stop' ? stopService(taskName) : uninstallService(taskName))
        console.log(result.message)
        return result.success ? 0 : 1
      }
      if (subcommand === 'status') {
        const status = getServiceStatus(taskName)
        console.log(`Registered: ${status.registered ? 'YES' : 'NO'}\nSupervisor: ${status.running ? 'RUNNING (or state needs attention)' : 'STOPPED'}\n${status.details}`)
        return status.registered ? 0 : 1
      }
      if (subcommand === 'logs') { printLogs(options.has('-f'), taskName); return 0 }
      throw new CliUsageError('Unknown service subcommand; use remora --help.')
    }
    if (command === 'host') {
      if (subcommand !== 'run') throw new CliUsageError('Unknown host subcommand; use remora --help.')
      const options = parseOptions(argv.slice(2), ['--profile', '--port', '--task-name', '--installed-task'])
      const installedTask = options.get('--installed-task')
      if (installedTask !== undefined && options.size !== 1) throw new CliUsageError('Installed tasks use their saved configuration exclusively.')
      const config = installedTask !== undefined ? readServiceConfig(validateTaskName(installedTask)) : {
        profile: validateProfile(options.get('--profile') ?? 'remora'), port: portOption(options), taskName: validateTaskName(options.get('--task-name') ?? 'RemoraHost'),
      }
      await new HostSupervisor(config).start()
      return 0
    }
    if (command === 'doctor') {
      const options = parseOptions(argv.slice(1), ['--profile', '--relay-url', '--task-name'])
      const report = await runDoctor(validateProfile(options.get('--profile') ?? 'remora'), options.get('--relay-url'), validateTaskName(options.get('--task-name') ?? 'RemoraHost'))
      printDoctorReport(report)
      return report.overallSuccess ? 0 : 1
    }
    throw new CliUsageError('Unknown command; use remora --help.')
  } catch (error: unknown) {
    console.error(error instanceof CliUsageError ? error.message : 'Remora could not complete this operation. Check runtime installation, service state and local file permissions.')
    return error instanceof CliUsageError ? 64 : 1
  }
}

/** Public entrypoint used by the packaged bin and command tests. */
export function main(argv: readonly string[]): Promise<number> {
  return mainAsync(argv)
}
