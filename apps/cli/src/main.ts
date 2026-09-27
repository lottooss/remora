/**
 * `remora` command dispatcher.
 * Task P5-O1: service install/uninstall/status/logs, host supervisor, doctor.
 */
import { installService, uninstallService, getServiceStatus, printLogs } from './service.ts'
import { HostSupervisor } from './supervisor.ts'
import { runDoctor, printDoctorReport } from './doctor.ts'

const USAGE = `remora — keep the Remora host running on this PC

Usage:
  remora service install [--dsh-version <v>] [--port 7717] [--profile remora]
  remora service uninstall | status | logs [-f]
  remora host run [--port 7717] [--profile remora]
  remora doctor [--profile remora] [--relay-url <url>]
  remora --help | --version`

function getOption(argv: readonly string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  if (idx !== -1 && idx + 1 < argv.length) {
    return argv[idx + 1]
  }
  return undefined
}

export async function mainAsync(argv: readonly string[]): Promise<number> {
  const [command, subcommand] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (command === '--version') {
    console.log('0.0.0')
    return 0
  }

  if (command === 'service') {
    if (subcommand === 'install') {
      const portStr = getOption(argv, '--port')
      const port = portStr ? parseInt(portStr, 10) : 7717
      const profile = getOption(argv, '--profile') ?? 'remora'
      const dshVersion = getOption(argv, '--dsh-version')
      const res = installService({ port, profile, dshVersion })
      console.log(res.message)
      return res.success ? 0 : 1
    }
    if (subcommand === 'uninstall') {
      const res = uninstallService()
      console.log(res.message)
      return res.success ? 0 : 1
    }
    if (subcommand === 'status') {
      const st = getServiceStatus()
      console.log(`Registered: ${st.registered ? 'YES' : 'NO'}`)
      console.log(`Running:    ${st.running ? 'YES' : 'NO'}`)
      if (st.details) console.log(`Details:    ${st.details}`)
      return st.registered ? 0 : 1
    }
    if (subcommand === 'logs') {
      const follow = argv.includes('-f')
      printLogs(follow)
      return 0
    }
    console.error(`remora service: unknown subcommand '${subcommand}'. Usage:\n  remora service install | uninstall | status | logs [-f]`)
    return 64
  }

  if (command === 'host') {
    if (subcommand === 'run') {
      const portStr = getOption(argv, '--port')
      const port = portStr ? parseInt(portStr, 10) : 7717
      const profile = getOption(argv, '--profile') ?? 'remora'
      const supervisor = new HostSupervisor({ port, profile })
      await supervisor.start()
      return 0
    }
    console.error(`remora host: unknown subcommand '${subcommand}'. Usage:\n  remora host run [--port 7717] [--profile remora]`)
    return 64
  }

  if (command === 'doctor') {
    const profile = getOption(argv, '--profile') ?? 'remora'
    const relayUrl = getOption(argv, '--relay-url')
    const report = await runDoctor(profile, relayUrl)
    printDoctorReport(report)
    return report.overallSuccess ? 0 : 1
  }

  console.error(`remora: unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
  return 64
}

/**
 * Synchronous CLI entrypoint compatible with existing tests.
 */
export function main(argv: readonly string[]): number | Promise<number> {
  const [command] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (command === '--version') {
    console.log('0.0.0')
    return 0
  }
  return mainAsync(argv)
}
