import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getDailyLogPath, getLogsDir } from './paths.ts'

export interface ServiceInstallOptions {
  dshVersion?: string | undefined
  port?: number | undefined
  profile?: string | undefined
}

export function installService(options: ServiceInstallOptions = {}): { success: boolean; message: string } {
  const port = options.port ?? 7717
  const profile = options.profile ?? 'remora'
  const currentScriptPath = fileURLToPath(import.meta.url)
  const cliBin = path.resolve(path.dirname(currentScriptPath), 'bin.js')

  if (process.platform === 'win32') {
    const nodeExe = process.execPath
    // Use conhost --headless to prevent window flashes at logon (ADR-0009 & P0-S6)
    const taskCommand = `conhost.exe --headless "${nodeExe}" "${cliBin}" host run --port ${port} --profile ${profile}`
    try {
      execSync(`schtasks /Create /TN RemoraHost /TR "${taskCommand}" /SC ONLOGON /RL LIMITED /F`, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        success: true,
        message: `Registered per-user logon task 'RemoraHost' (port ${port}, profile ${profile}) without admin rights.`,
      }
    } catch {
      // Fallback to HKCU\...\Run
      try {
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoraHost" /t REG_SZ /d "${taskCommand}" /f`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return {
          success: true,
          message: `Registered HKCU\\Run autostart entry 'RemoraHost' (port ${port}, profile ${profile}).`,
        }
      } catch (err2: unknown) {
        const msg = err2 instanceof Error ? err2.message : String(err2)
        return { success: false, message: `Failed to install Windows logon task: ${msg}` }
      }
    }
  }

  if (process.platform === 'linux') {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user')
    fs.mkdirSync(serviceDir, { recursive: true })
    const serviceFile = path.join(serviceDir, 'remora.service')
    const unitContent = `[Unit]
Description=Remora Host Service
After=network.target

[Service]
ExecStart=${process.execPath} ${cliBin} host run --port ${port} --profile ${profile}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`
    fs.writeFileSync(serviceFile, unitContent, 'utf8')
    try {
      execSync('systemctl --user daemon-reload && systemctl --user enable remora', { stdio: 'ignore' })
      return { success: true, message: `Installed and enabled systemd user service: ${serviceFile}` }
    } catch {
      return { success: true, message: `Wrote service file ${serviceFile}. Enable via: systemctl --user enable remora` }
    }
  }

  if (process.platform === 'darwin') {
    const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    fs.mkdirSync(launchAgentsDir, { recursive: true })
    const plistFile = path.join(launchAgentsDir, 'io.github.lottooss.remora.plist')
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>io.github.lottooss.remora</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${cliBin}</string>
        <string>host</string>
        <string>run</string>
        <string>--port</string>
        <string>${port}</string>
        <string>--profile</string>
        <string>${profile}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
`
    fs.writeFileSync(plistFile, plistContent, 'utf8')
    return { success: true, message: `Installed LaunchAgent plist: ${plistFile}` }
  }

  return { success: false, message: `Platform ${process.platform} is not supported for automated service install.` }
}

export function uninstallService(): { success: boolean; message: string } {
  if (process.platform === 'win32') {
    let uninstalledAny = false
    try {
      execSync('schtasks /Delete /TN RemoraHost /F', { stdio: ['ignore', 'pipe', 'pipe'] })
      uninstalledAny = true
    } catch {
      // Ignored
    }
    try {
      execSync('reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "RemoraHost" /f', {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      uninstalledAny = true
    } catch {
      // Ignored
    }
    return {
      success: true,
      message: uninstalledAny ? "Uninstalled Windows logon task 'RemoraHost'." : 'No RemoraHost task found.',
    }
  }

  if (process.platform === 'linux') {
    const serviceFile = path.join(os.homedir(), '.config', 'systemd', 'user', 'remora.service')
    try {
      execSync('systemctl --user disable --now remora', { stdio: 'ignore' })
    } catch {
      // Ignored
    }
    if (fs.existsSync(serviceFile)) {
      fs.unlinkSync(serviceFile)
    }
    return { success: true, message: 'Uninstalled systemd user service remora.' }
  }

  if (process.platform === 'darwin') {
    const plistFile = path.join(os.homedir(), 'Library', 'LaunchAgents', 'io.github.lottooss.remora.plist')
    if (fs.existsSync(plistFile)) {
      try {
        execSync(`launchctl unload "${plistFile}"`, { stdio: 'ignore' })
      } catch {
        // Ignored
      }
      fs.unlinkSync(plistFile)
    }
    return { success: true, message: 'Uninstalled LaunchAgent plist.' }
  }

  return { success: false, message: `Platform ${process.platform} not supported for service uninstall.` }
}

export function getServiceStatus(): { registered: boolean; running: boolean; details: string } {
  if (process.platform === 'win32') {
    try {
      const output = execSync('schtasks /Query /TN RemoraHost', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const isRunning = output.toLowerCase().includes('running')
      return { registered: true, running: isRunning, details: output.trim() }
    } catch {
      return { registered: false, running: false, details: 'RemoraHost task is not registered in Task Scheduler.' }
    }
  }
  return { registered: false, running: false, details: `Platform ${process.platform}` }
}

export function printLogs(follow: boolean = false): void {
  const logPath = getDailyLogPath()
  if (!fs.existsSync(logPath)) {
    const logsDir = getLogsDir()
    console.log(`No logs found at ${logPath}. Check ${logsDir}.`)
    return
  }

  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split('\n')
  const tail = lines.slice(-50).join('\n')
  console.log(tail)

  if (follow) {
    console.log('\n--- Following log output (Ctrl+C to stop) ---')
    let lastSize = fs.statSync(logPath).size
    setInterval(() => {
      try {
        const stat = fs.statSync(logPath)
        if (stat.size > lastSize) {
          const stream = fs.createReadStream(logPath, { start: lastSize, end: stat.size })
          stream.pipe(process.stdout)
          lastSize = stat.size
        }
      } catch {
        // Ignored
      }
    }, 1000)
  }
}
