import os from 'node:os'
import path from 'node:path'

export function getAppDataDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'Remora')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Remora')
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(xdgData, 'remora')
}

export function getRuntimeDir(): string {
  return path.join(getAppDataDir(), 'runtime')
}

export function getLogsDir(): string {
  return path.join(getAppDataDir(), 'logs')
}

export function getDailyLogPath(date: Date = new Date()): string {
  const dateStr = date.toISOString().slice(0, 10)
  return path.join(getLogsDir(), `remora-${dateStr}.log`)
}

export function getDshHomeDir(): string {
  const custom = process.env.DSH_HOME
  if (custom && custom.trim() !== '') return custom
  return path.join(os.homedir(), '.dsh')
}

export function getDshProfileDir(profile: string = 'remora'): string {
  return path.join(getDshHomeDir(), 'profiles', profile)
}
