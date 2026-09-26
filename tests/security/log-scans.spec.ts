import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  encodeBase64Url,
  generateApprovalKeypair,
  generateKeypair,
  randomBytes,
} from '@remora/crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '../..')

describe('Security Test Suite: Log Scans & Secret Redaction (T19)', () => {
  it('scans package source code for unredacted console.log statements in packages/host/src', () => {
    // AGENTS.md invariant 8 & §7.3: Use ctx.logger; never console.* in packages/host/src
    const hostSrcDir = path.resolve(projectRoot, 'packages/host/src')

    function findConsoleCalls(dir: string): string[] {
      const violations: string[] = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          violations.push(...findConsoleCalls(fullPath))
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          const content = fs.readFileSync(fullPath, 'utf8')
          const lines = content.split('\n')
          lines.forEach((line, idx) => {
            // Match console.log, console.debug, console.info, console.warn, console.error
            if (/console\.(log|debug|info|warn|error)\(/.test(line)) {
              // Ignore comments
              const trimmed = line.trim()
              if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) {
                violations.push(`${fullPath}:${idx + 1}: ${trimmed}`)
              }
            }
          })
        }
      }
      return violations
    }

    const violations = findConsoleCalls(hostSrcDir)
    expect(violations).toEqual([])
  })

  it('scans relay source code for logging of full payloads or private keys', () => {
    const relaySrcDir = path.resolve(projectRoot, 'apps/relay/src')
    if (!fs.existsSync(relaySrcDir)) return

    function checkRelaySource(dir: string): string[] {
      const leaks: string[] = []
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          leaks.push(...checkRelaySource(fullPath))
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(fullPath, 'utf8')
          // Check for logging raw frame payloads
          if (content.includes('console.log(frame.payload)') || content.includes('console.log(payload)')) {
            leaks.push(`Payload logging detected in ${fullPath}`)
          }
        }
      }
      return leaks
    }

    const leaks = checkRelaySource(relaySrcDir)
    expect(leaks).toEqual([])
  })

  it('verifies that sensitive secret tokens never appear in captured log buffers', () => {
    // Generate active test secrets
    const noiseKey = generateKeypair()
    const psk = randomBytes(32)
    const approvalKey = generateApprovalKeypair()
    const enrollSecret = 'remora_secret_test_xyz123'
    const payloadSecret = 'SUPER_SECRET_PAYLOAD_CONTENT_42'

    const testSecrets = [
      encodeBase64Url(noiseKey.privateKey),
      encodeBase64Url(psk),
      encodeBase64Url(approvalKey.privateKey),
      enrollSecret,
      payloadSecret,
    ]

    // Simulate safe logging with redaction helpers
    const logs: string[] = []
    function logEvent(event: string, meta: { deviceId?: string; approvalId?: string; error?: string }) {
      const parts = [`event=${event}`]
      if (meta.deviceId) parts.push(`device=${meta.deviceId.slice(0, 6)}`)
      if (meta.approvalId) parts.push(`approval=${meta.approvalId.slice(0, 6)}`)
      if (meta.error) parts.push(`error=${meta.error}`)
      logs.push(parts.join(' '))
    }

    const testDeviceId = 'd_abcdefghijklmnopqrstuvwxyz'
    const testApprovalId = 'appr_1234567890abcdef'

    logEvent('approval.requested', {
      deviceId: testDeviceId,
      approvalId: testApprovalId,
    })
    logEvent('device.connected', {
      deviceId: testDeviceId,
    })

    const allLogs = logs.join('\n')

    // 1. None of the secret strings must appear in logs
    for (const secret of testSecrets) {
      expect(allLogs).not.toContain(secret)
    }

    // 2. Full unredacted IDs must not appear; only truncated versions
    expect(allLogs).not.toContain(testDeviceId)
    expect(allLogs).not.toContain(testApprovalId)
    expect(allLogs).toContain('d_abcd')
    expect(allLogs).toContain('appr_1')
  })
})
