/**
 * `remora` command dispatcher. Skeleton: prints usage and names the task that
 * implements each command. Task P5-O1 implements service
 * install/uninstall/status/logs, the `host run` supervisor, and `doctor`
 * (ADR-0009).
 */

const USAGE = `remora — keep the Remora host running on this PC

Usage:
  remora service install [--dsh-version <v>] [--port 7717] [--profile remora]
  remora service uninstall | status | logs [-f]
  remora host run          supervisor started at logon (not for interactive use)
  remora doctor            check Node, dsh, profile, bundle, relay, service, keep-awake
  remora --help | --version`

const PLANNED: Readonly<Record<string, string>> = {
  service: 'P5-O1',
  host: 'P5-O1',
  doctor: 'P5-O1',
}

/**
 * Run the CLI for one argument vector.
 * @param argv - arguments after the executable and script path.
 * @returns the process exit code.
 */
export function main(argv: readonly string[]): number {
  const [command] = argv
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }
  if (command === '--version') {
    console.log('0.0.0')
    return 0
  }
  const task = PLANNED[command]
  if (task !== undefined) {
    console.error(`remora ${command}: not implemented yet (task ${task})`)
    return 2
  }
  console.error(`remora: unknown command ${JSON.stringify(command)}\n\n${USAGE}`)
  return 64
}
