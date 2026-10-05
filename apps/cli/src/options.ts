/** Errors safe to display at the CLI boundary; never wrap raw subprocess output. */
export class CliUsageError extends Error {}

/** Limit the supervisor to Remora's dedicated profiles. */
export function validateProfile(profile: string): string {
  if (!/^remora(?:-[A-Za-z0-9_-]{1,48})?$/.test(profile)) {
    throw new CliUsageError('Profile must be remora or remora-<name>.')
  }
  return profile
}

/** Task names also scope local supervisor state, never filesystem paths. */
export function validateTaskName(taskName: string): string {
  if (!/^Remora[A-Za-z0-9_-]{0,58}$/.test(taskName)) {
    throw new CliUsageError('Task name must start with Remora and contain only letters, digits, _ or - (up to 64 characters).')
  }
  return taskName
}

/** Reject partial integers, missing values and ports outside the TCP range. */
export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliUsageError('Port must be an integer between 1 and 65535.')
  }
  return port
}

/** Parse only explicitly supported options; duplicates and unknown options fail. */
export function parseOptions(argv: readonly string[], values: readonly string[], flags: readonly string[] = []): Map<string, string> {
  const result = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === undefined || result.has(key)) throw new CliUsageError('Duplicate option.')
    if (flags.includes(key)) {
      result.set(key, 'true')
    } else if (values.includes(key)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('-') || value.trim() === '') {
        throw new CliUsageError(`Missing value for ${key}.`)
      }
      result.set(key, value)
    } else {
      throw new CliUsageError('Unknown option; use remora --help.')
    }
  }
  return result
}
