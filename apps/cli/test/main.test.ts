import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { main, mainAsync } from '../src/main.ts'
import { checkNodeVersion, checkKeepAwakeSupport, checkPowerSettingsHints } from '../src/doctor.ts'
import { rotateLogs, HostSupervisor } from '../src/supervisor.ts'
import { getAppDataDir, getRuntimeDir, getLogsDir } from '../src/paths.ts'

describe('remora CLI dispatcher', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints usage for --help and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await main(['--help'])
    expect(code).toBe(0)
    expect(log.mock.calls[0]?.[0]).toMatch(/remora service install/)
  })

  it('prints version for --version and exits 0', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await main(['--version'])
    expect(code).toBe(0)
    expect(log.mock.calls[0]?.[0]).toBe('0.0.0')
  })

  it('rejects unknown commands with exit code 64', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await mainAsync(['frobnicate'])
    expect(code).toBe(64)
  })

  it('rejects unknown service subcommand with exit code 64', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await mainAsync(['service', 'unknown'])
    expect(code).toBe(64)
  })

  it('rejects unknown host subcommand with exit code 64', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await mainAsync(['host', 'unknown'])
    expect(code).toBe(64)
  })

  it('service status reports status without crashing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await mainAsync(['service', 'status'])
    expect(typeof code).toBe('number')
  })

  it('service logs handles missing logs gracefully', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const code = await mainAsync(['service', 'logs'])
    expect(code).toBe(0)
    expect(log.mock.calls.length).toBeGreaterThan(0)
  })
})

describe('doctor checks', () => {
  it('checkNodeVersion passes on Node >= 24', async () => {
    const check = await checkNodeVersion()
    expect(check.status).toBe('pass')
    expect(check.message).toContain('v')
  })

  it('checkKeepAwakeSupport identifies platform support', async () => {
    const check = await checkKeepAwakeSupport()
    expect(check.status).toBe('pass')
    expect(check.message).toContain('supported')
  })

  it('checkPowerSettingsHints returns actionable hints', () => {
    const check = checkPowerSettingsHints()
    expect(check.status).toBe('pass')
    expect(check.message).toContain('Win+L')
  })
})

describe('supervisor and paths', () => {
  it('returns valid paths for AppData and logs', () => {
    expect(getAppDataDir()).toBeDefined()
    expect(getRuntimeDir()).toContain('runtime')
    expect(getLogsDir()).toContain('logs')
  })

  it('rotateLogs deletes logs older than maxDays', () => {
    const tempDir = path.join(os.tmpdir(), `remora-test-logs-${Date.now()}`)
    fs.mkdirSync(tempDir, { recursive: true })

    const oldLog = path.join(tempDir, 'remora-2020-01-01.log')
    const freshLog = path.join(tempDir, 'remora-2026-09-27.log')
    fs.writeFileSync(oldLog, 'old log content', 'utf8')
    fs.writeFileSync(freshLog, 'fresh log content', 'utf8')

    // Set mtime of oldLog to 30 days ago
    const thirtyDaysAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(oldLog, thirtyDaysAgo, thirtyDaysAgo)

    rotateLogs(tempDir, 14)

    expect(fs.existsSync(oldLog)).toBe(false)
    expect(fs.existsSync(freshLog)).toBe(true)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('HostSupervisor instantiates with defaults', () => {
    const supervisor = new HostSupervisor({ port: 7717, profile: 'remora' })
    expect(supervisor).toBeDefined()
  })
})
