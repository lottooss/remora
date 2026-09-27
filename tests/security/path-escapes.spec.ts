import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import {
  canonicalize,
  contains,
  resolveRoots,
  DefaultPolicyGuard,
} from '@remora/host'

describe('Security Test Suite: Path Escapes & Boundary Traversal (T12, T13)', () => {
  const isWindows = process.platform === 'win32'
  const tempBase = fs.realpathSync.native(os.tmpdir())
  const testRoot = path.join(tempBase, `remora-path-sec-${Date.now()}`)
  const workspaceRoot = path.join(testRoot, 'workspace')
  const secretDir = path.join(testRoot, 'secrets')

  fs.mkdirSync(workspaceRoot, { recursive: true })
  fs.mkdirSync(secretDir, { recursive: true })
  fs.writeFileSync(path.join(workspaceRoot, 'safe.txt'), 'safe')
  fs.writeFileSync(path.join(secretDir, 'secret.env'), 'API_KEY=topsecret')

  const guard = new DefaultPolicyGuard({
    remoteRoots: [workspaceRoot],
    allowRemoteSessionStart: true,
  })

  it('denies parent directory traversal (..)', () => {
    const maliciousPaths = [
      path.join(workspaceRoot, '..', 'secrets', 'secret.env'),
      path.join(workspaceRoot, 'subdir', '..', '..', 'secrets', 'secret.env'),
      `${workspaceRoot}/../../secrets/secret.env`,
      `${workspaceRoot}/safe.txt/../../../secret.env`,
    ]

    for (const p of maliciousPaths) {
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
      expect(guard.checkPathAccess(p, [workspaceRoot])).toBe(false)
    }
  })

  it('denies absolute paths outside permitted roots', () => {
    const outsidePaths = [
      secretDir,
      path.join(secretDir, 'secret.env'),
      isWindows ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd',
      isWindows ? 'C:\\Windows' : '/var/log',
    ]

    for (const p of outsidePaths) {
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
      expect(guard.checkPathAccess(p, [workspaceRoot])).toBe(false)
    }
  })

  it('denies directory junction escapes on Windows', () => {
    if (!isWindows) return

    const junctionLink = path.join(workspaceRoot, 'junction_to_secret')
    try {
      execSync(`mklink /J "${junctionLink}" "${secretDir}"`, { shell: 'cmd.exe', stdio: 'ignore' })
    } catch {
      // If junction creation is not permitted, skip gracefully
      return
    }

    try {
      const escapeTarget = path.join(junctionLink, 'secret.env')
      // Even though junction_to_secret is inside workspaceRoot syntactically,
      // native canonicalization resolves it to secretDir and denies access!
      const isContained = guard.isPathContained(workspaceRoot, escapeTarget)
      expect(isContained).toBe(false)
      expect(guard.checkPathAccess(escapeTarget, [workspaceRoot])).toBe(false)
    } finally {
      try {
        fs.rmdirSync(junctionLink)
      } catch {
        // ignore
      }
    }
  })

  it('denies symlink escapes pointing outside root', () => {
    const symlinkPath = path.join(workspaceRoot, 'symlink_outside')
    try {
      fs.symlinkSync(secretDir, symlinkPath, isWindows ? 'junction' : 'dir')
    } catch {
      // Symlinks may require elevated privileges on Windows
      return
    }

    try {
      const target = path.join(symlinkPath, 'secret.env')
      expect(guard.isPathContained(workspaceRoot, target)).toBe(false)
      expect(guard.checkPathAccess(target, [workspaceRoot])).toBe(false)
    } finally {
      try {
        fs.unlinkSync(symlinkPath)
      } catch {
        try { fs.rmdirSync(symlinkPath) } catch { /* ignore */ }
      }
    }
  })

  it('denies Windows UNC network paths', () => {
    const uncPaths = [
      '\\\\attacker.evil\\share\\payload.exe',
      '\\\\192.168.1.100\\c$\\windows\\system32',
      '//evil-server/share/file',
    ]

    for (const p of uncPaths) {
      expect(() => canonicalize(p)).toThrow()
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
      expect(guard.checkPathAccess(p, [workspaceRoot])).toBe(false)
    }
  })

  it('denies Windows device namespaces (\\\\.\\ and \\\\?\\)', () => {
    const devicePaths = [
      '\\\\.\\C:\\Windows\\System32',
      '\\\\?\\C:\\Users\\admin',
      '\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\',
    ]

    for (const p of devicePaths) {
      expect(() => canonicalize(p)).toThrow()
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
      expect(guard.checkPathAccess(p, [workspaceRoot])).toBe(false)
    }
  })

  it('denies Alternate Data Streams (ADS) on Windows', () => {
    const adsPaths = [
      path.join(workspaceRoot, 'safe.txt:hidden.exe'),
      path.join(workspaceRoot, 'safe.txt::$DATA'),
    ]

    for (const p of adsPaths) {
      expect(() => canonicalize(p)).toThrow()
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
    }
  })

  it('denies NUL bytes and control characters', () => {
    const malicious = [
      path.join(workspaceRoot, 'safe.txt\0.jpg'),
      `${workspaceRoot}/safe.txt\0evil`,
      `${workspaceRoot}/safe\n.txt`,
      `${workspaceRoot}/safe\r.txt`,
    ]

    for (const p of malicious) {
      expect(() => canonicalize(p)).toThrow()
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
    }
  })

  it('denies trailing dots and spaces evasion on Windows', () => {
    if (!isWindows) return

    const trailingPaths = [
      path.join(workspaceRoot, 'safe.txt.'),
      path.join(workspaceRoot, 'safe.txt..'),
      path.join(workspaceRoot, 'safe.txt   '),
      path.join(workspaceRoot, 'safe.txt. . '),
    ]

    for (const p of trailingPaths) {
      expect(() => canonicalize(p)).toThrow()
      expect(guard.isPathContained(workspaceRoot, p)).toBe(false)
    }
  })

  it('denies 8.3 short name escapes to sensitive directories', () => {
    if (!isWindows) return

    // PROGRA~1 or similar outside root
    const shortNames = [
      'C:\\PROGRA~1',
      'C:\\PROGRA~2',
    ]

    for (const sn of shortNames) {
      if (fs.existsSync(sn)) {
        expect(guard.isPathContained(workspaceRoot, sn)).toBe(false)
        expect(guard.checkPathAccess(sn, [workspaceRoot])).toBe(false)
      }
    }
  })

  it('allows genuine files strictly contained within roots', () => {
    const safeFile = path.join(workspaceRoot, 'safe.txt')
    expect(guard.isPathContained(workspaceRoot, safeFile)).toBe(true)
    expect(guard.checkPathAccess(safeFile, [workspaceRoot])).toBe(true)
  })
})
