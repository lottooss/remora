import fs from 'node:fs'
import path from 'node:path'
import type { NotifyPrefs } from '@remora/protocol'

export interface NotifyPrefsStore {
  getPrefs(deviceId: string): NotifyPrefs
  setPrefs(deviceId: string, prefs: Partial<NotifyPrefs>): NotifyPrefs
}

const DEFAULT_PREFS: NotifyPrefs = {
  approval: true,
  question: true,
  turnDone: true,
  turnError: true,
}

interface SerializedNotifyPrefs {
  approval: boolean
  question: boolean
  turnDone: boolean
  turnError: boolean
}

export class InMemoryNotifyPrefsStore implements NotifyPrefsStore {
  private readonly prefsByDevice = new Map<string, NotifyPrefs>()

  constructor(private readonly storageFilePath?: string | undefined) {
    if (storageFilePath) {
      this.loadFromFile(storageFilePath)
    }
  }

  getPrefs(deviceId: string): NotifyPrefs {
    return this.prefsByDevice.get(deviceId) ?? { ...DEFAULT_PREFS }
  }

  setPrefs(deviceId: string, prefs: Partial<NotifyPrefs>): NotifyPrefs {
    const current = this.getPrefs(deviceId)
    const updated: NotifyPrefs = {
      approval: prefs.approval ?? current.approval,
      question: prefs.question ?? current.question,
      turnDone: prefs.turnDone ?? current.turnDone,
      turnError: prefs.turnError ?? current.turnError,
    }
    this.prefsByDevice.set(deviceId, updated)
    this.persistToFile()
    return updated
  }

  private loadFromFile(filePath: string): void {
    if (!fs.existsSync(filePath)) return
    try {
      const data = fs.readFileSync(filePath, 'utf8')
      const records: Record<string, SerializedNotifyPrefs> = JSON.parse(data)
      for (const [deviceId, prefs] of Object.entries(records)) {
        this.prefsByDevice.set(deviceId, { ...prefs })
      }
    } catch {
      // If file is corrupt or unreadable, preserve memory state
    }
  }

  private persistToFile(): void {
    if (!this.storageFilePath) return
    try {
      const dir = path.dirname(this.storageFilePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const serialized: Record<string, SerializedNotifyPrefs> = {}
      for (const [deviceId, prefs] of this.prefsByDevice) {
        serialized[deviceId] = { ...prefs }
      }
      fs.writeFileSync(this.storageFilePath, JSON.stringify(serialized, null, 2), 'utf8')
    } catch {
      // Non-fatal if write fails
    }
  }
}
