/**
 * P6-T2 Security Hardening Suite (Threat Model T17, T18, T27, T29, T30)
 *
 * Verifies:
 * 1. T17: Hostile git configurations cannot achieve code execution during diffs.* operations.
 *    - core.hooksPath override isolates malicious repository hooks.
 *    - core.fsmonitor=false prevents arbitrary binary execution.
 *    - --no-ext-diff and --no-textconv prevent external filter executions.
 * 2. T18, T27: Push notification encryption integrity and key isolation.
 *    - Tampered or bit-flipped push ciphertext fails AEAD authentication.
 *    - Push payload encrypted for device A cannot be decrypted by device B.
 *    - Sealed push payloads contain zero plaintext metadata or conversation secrets.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { GitAdapter } from '../../packages/host/src/adapter/git.ts'
import {
  sealPushPayload,
  openPushPayload,
  randomBytes,
} from '../../packages/crypto/src/index.ts'

describe('P6-T2 Security Hardening', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remora-sec-hardening-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('T17: Git hardening against hostile repository configs', () => {
    it('prevents execution of malicious git hooks and config directives', async () => {
      // 1. Initialize git repo in tempDir and create initial commit cleanly
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.name', 'Security Auditor'], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'user.email', 'auditor@example.com'], { cwd: tempDir, stdio: 'ignore' })

      const testFile = path.join(tempDir, 'sample.txt')
      fs.writeFileSync(testFile, 'initial content\n')
      execFileSync('git', ['add', 'sample.txt'], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir, stdio: 'ignore' })

      // 2. Set up hostile script and sentinel marker
      const sentinelFile = path.join(tempDir, 'pwned.marker')
      const hostileScript = path.join(tempDir, process.platform === 'win32' ? 'hostile.bat' : 'hostile.sh')

      if (process.platform === 'win32') {
        fs.writeFileSync(hostileScript, `@echo off\r\necho pwned > "${sentinelFile}"\r\n`)
      } else {
        fs.writeFileSync(hostileScript, `#!/bin/sh\necho pwned > "${sentinelFile}"\n`, { mode: 0o755 })
      }

      // Set up hostile hooks in .git/hooks/
      const hooksDir = path.join(tempDir, '.git', 'hooks')
      fs.mkdirSync(hooksDir, { recursive: true })
      for (const hookName of ['post-checkout', 'pre-commit', 'fsmonitor-watchman']) {
        const hookFile = path.join(hooksDir, process.platform === 'win32' ? `${hookName}.bat` : hookName)
        if (process.platform === 'win32') {
          fs.writeFileSync(hookFile, `@echo off\r\necho pwned > "${sentinelFile}"\r\n`)
        } else {
          fs.writeFileSync(hookFile, `#!/bin/sh\necho pwned > "${sentinelFile}"\n`, { mode: 0o755 })
        }
      }

      // Inject hostile diff / textconv / fsmonitor configs in .git/config
      execFileSync('git', ['config', 'diff.external', `"${hostileScript}"`], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'core.fsmonitor', `"${hostileScript}"`], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'diff.hostile.command', `"${hostileScript}"`], { cwd: tempDir, stdio: 'ignore' })
      execFileSync('git', ['config', 'diff.hostile.textconv', `"${hostileScript}"`], { cwd: tempDir, stdio: 'ignore' })

      // Modify tracked file
      fs.writeFileSync(testFile, 'initial content\nmodified content\n')

      if (fs.existsSync(sentinelFile)) {
        fs.unlinkSync(sentinelFile)
      }

      // 3. Run GitAdapter commands through hardened runner
      const adapter = new GitAdapter()
      const isRepo = await adapter.isGitRepo(tempDir)
      expect(isRepo).toBe(true)

      const status = await adapter.getStatus(tempDir)
      expect(status).not.toBeNull()
      expect(status?.files.length).toBeGreaterThan(0)

      const diff = await adapter.getFileDiff(tempDir, 'sample.txt')
      expect(diff.hunks.length).toBeGreaterThan(0)

      // 4. Verify: sentinel marker was NEVER created
      expect(fs.existsSync(sentinelFile)).toBe(false)
    })
  })

  describe('T18, T27: Push notification encryption integrity and key isolation', () => {
    it('fails closed when push ciphertext is tampered or decrypted with wrong key', () => {
      const deviceAPushKey = randomBytes(32)
      const deviceBPushKey = randomBytes(32)

      const payload = {
        type: 'approval',
        approvalId: 'app_secret_123',
        sessionId: 'sess_top_secret_456',
        command: 'rm -rf /sensitive/data',
        risk: 'high',
        issuedAt: Date.now(),
      }

      const sealed = sealPushPayload(deviceAPushKey, payload)
      expect(sealed.length).toBeGreaterThan(28) // 12 nonce + ciphertext + 16 tag

      // 1. Bit-flipped ciphertext must fail authentication
      const tamperedCiphertext = new Uint8Array(sealed)
      tamperedCiphertext[15] ^= 0xff

      expect(() => {
        openPushPayload(deviceAPushKey, tamperedCiphertext)
      }).toThrow()

      // 2. Truncated payload must throw
      expect(() => {
        openPushPayload(deviceAPushKey, sealed.subarray(0, 20))
      }).toThrow()

      // 3. Key isolation: Device B cannot decrypt payload meant for Device A
      expect(() => {
        openPushPayload(deviceBPushKey, sealed)
      }).toThrow()

      // 4. Clean round-trip succeeds for legitimate recipient
      const opened = openPushPayload(deviceAPushKey, sealed)
      expect(opened).toEqual(payload)

      // 5. Zero plaintext leakage: sealed payload does not contain confidential strings
      const rawText = new TextDecoder('utf-8', { fatal: false }).decode(sealed)
      expect(rawText).not.toContain('app_secret_123')
      expect(rawText).not.toContain('sess_top_secret_456')
      expect(rawText).not.toContain('rm -rf')
    })
  })
})
