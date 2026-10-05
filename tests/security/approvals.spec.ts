import { describe, expect, it } from 'vitest'
import {
  DefaultPolicyGuard,
  InMemoryDeviceRegistry,
  PendingRegistry,
  RcpServer,
  registerInteractionMethods,
} from '@remora/host'
import {
  buildCanonicalApprovalMessage,
  computeArgsDigest,
  encodeBase64Url,
  generateApprovalKeypair,
  signApprovalMessage,
  utf8ToBytes,
} from '@remora/crypto'

describe('Security Test Suite: Approvals, Signatures & Replays (T05, T09, T10, T14, T24)', () => {
  const hostId = 'h_erruijsx3ey2rmxcpeh3pgxjkm'
  const deviceId = 'd_erruijsx3ey2rmxcpeh3pgxjkm'

  function setupHost() {
    const registry = new InMemoryDeviceRegistry()
    const pendingRegistry = new PendingRegistry()
    const rcpServer = new RcpServer({ hostId, hostName: 'SecTestHost' })
    const policyGuard = new DefaultPolicyGuard({
      approvalBiometric: 'high',
    })

    const { privateKey, publicKeySpkiDer } = generateApprovalKeypair()

    registry.addDevice({
      deviceId,
      name: 'TestPhone',
      noisePublicKey: new Uint8Array(32),
      devicePsk: new Uint8Array(32),
      pushKey: new Uint8Array(32),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      approvalPublicKey: publicKeySpkiDer,
      revoked: false,
    })

    registerInteractionMethods(rcpServer, pendingRegistry, registry, policyGuard, hostId)

    return {
      registry,
      pendingRegistry,
      rcpServer,
      policyGuard,
      deviceKeypair: { privateKey, publicKeySpkiDer },
    }
  }

  async function sendRpc(
    rcpServer: RcpServer,
    method: string,
    params: Record<string, unknown>,
    id = 1,
  ) {
    const rawMessage = JSON.stringify({
      k: 'req',
      id,
      m: method,
      p: params,
    })
    const resJson = await rcpServer.handleMessage(rawMessage, {
      deviceId,
      channelId: 1,
    })
    expect(resJson).not.toBeNull()
    return JSON.parse(resJson!) as {
      k: 'res'
      id: number
      ok: boolean
      r?: any
      e?: { code: string; message: string; data?: any; retryAfterMs?: number }
    }
  }

  it('rejects unsigned high-risk approval (T10)', async () => {
    const { pendingRegistry, rcpServer } = setupHost()

    const preview = { text: 'rm -rf /tmp/data', json: '{"cmd":"rm -rf /tmp/data"}' }
    const argsDigest = computeArgsDigest(preview)
    const id = '11111111-1111-4111-8111-111111111111'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview,
      argsDigest,
      risk: 'high',
      requiresSignature: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    const res = await sendRpc(rcpServer, 'approvals.answer', {
      id,
      outcome: 'allowed-once',
      argsDigest,
      issuedAt: Date.now(),
    })

    expect(res.ok).toBe(false)
    expect(res.e?.code).toBe('signature_required')
  })

  it('rejects invalid/forged signature (T10)', async () => {
    const { pendingRegistry, rcpServer } = setupHost()

    const preview = { text: 'git push origin --force', json: '{"cmd":"force push"}' }
    const argsDigest = computeArgsDigest(preview)
    const id = '22222222-2222-4222-8222-222222222222'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview,
      argsDigest,
      risk: 'high',
      requiresSignature: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    // Random 64 bytes instead of valid signature
    const forgedSig = encodeBase64Url(new Uint8Array(64).fill(0xaa))

    const res = await sendRpc(rcpServer, 'approvals.answer', {
      id,
      outcome: 'allowed-once',
      argsDigest,
      issuedAt: Date.now(),
      sig: forgedSig,
    })

    expect(res.ok).toBe(false)
    expect(res.e?.code).toBe('signature_invalid')
  })

  it('accepts valid high-S DER signatures from Android Keystore (Crypto/1 §7)', async () => {
    const { policyGuard, deviceKeypair } = setupHost()

    const issuedAt = Date.now()
    const argsDigest = 'a'.repeat(64)
    const approvalId = '33333333-3333-4333-8333-333333333333'
    const canonicalMsg = buildCanonicalApprovalMessage({
      hostId,
      deviceId,
      sessionId: 'ses_1',
      toolName: 'bash',
      approvalId,
      outcome: 'allowed-once',
      issuedAt,
      argsDigest,
    })

    const validSigDer = signApprovalMessage(deviceKeypair.privateKey, utf8ToBytes(canonicalMsg))

    // SECP256R1 curve order N
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n

    // In a DER sequence: 0x30 [len] 0x02 [r_len] [r] 0x02 [s_len] [s]
    let offset = 2
    if (validSigDer[1]! & 0x80) offset += (validSigDer[1]! & 0x7f)
    expect(validSigDer[offset]).toBe(0x02)
    const rLen = validSigDer[offset + 1]!
    const rBytes = validSigDer.subarray(offset + 2, offset + 2 + rLen)

    const sOffset = offset + 2 + rLen
    expect(validSigDer[sOffset]).toBe(0x02)
    const sLen = validSigDer[sOffset + 1]!
    const sBytes = validSigDer.subarray(sOffset + 2, sOffset + 2 + sLen)

    // Convert s to BigInt
    let sBig = 0n
    for (const b of sBytes) {
      sBig = (sBig << 8n) | BigInt(b)
    }

    // Compute high-S: S' = N - S
    const highSBig = N - sBig
    let highSHex = highSBig.toString(16)
    if (highSHex.length % 2 !== 0) highSHex = '0' + highSHex
    let highSBytes = new Uint8Array(highSHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)))
    if (highSBytes[0]! & 0x80) {
      const padded = new Uint8Array(highSBytes.length + 1)
      padded.set(highSBytes, 1)
      highSBytes = padded
    }

    // Reconstruct DER with high-S
    const newDerLen = 2 + rBytes.length + 2 + highSBytes.length
    const highSDer = new Uint8Array(2 + newDerLen)
    highSDer[0] = 0x30
    highSDer[1] = newDerLen
    highSDer[2] = 0x02
    highSDer[3] = rBytes.length
    highSDer.set(rBytes, 4)
    const newSOffset = 4 + rBytes.length
    highSDer[newSOffset] = 0x02
    highSDer[newSOffset + 1] = highSBytes.length
    highSDer.set(highSBytes, newSOffset + 2)

    // High-S signatures from Android Keystore must be accepted per Crypto/1 §7 (lowS: false)
    const verifyResult = policyGuard.verifyApprovalSignature({
      hostId,
      deviceId,
      sessionId: 'ses_1',
      toolName: 'bash',
      approvalId,
      outcome: 'allowed-once',
      argsDigest,
      expectedArgsDigest: argsDigest,
      issuedAt,
      risk: 'high',
      approvalPublicKey: deviceKeypair.publicKeySpkiDer,
      sig: encodeBase64Url(highSDer),
      now: issuedAt,
    })

    expect(verifyResult.ok).toBe(true)
  })

  it('rejects preview argsDigest mismatch (T14)', async () => {
    const { pendingRegistry, rcpServer } = setupHost()

    const genuinePreview = { text: 'echo "hello"', json: '{"cmd":"echo hello"}' }
    const genuineDigest = computeArgsDigest(genuinePreview)
    const id = '44444444-4444-4444-8444-444444444444'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview: genuinePreview,
      argsDigest: genuineDigest,
      risk: 'normal',
      requiresSignature: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    // Attacker modifies argsDigest in RPC
    const tamperedDigest = 'sha256:' + '0'.repeat(64)

    const res = await sendRpc(rcpServer, 'approvals.answer', {
      id,
      outcome: 'allowed-once',
      argsDigest: tamperedDigest,
      issuedAt: Date.now(),
    })

    expect(res.ok).toBe(false)
    expect(res.e?.message).toContain('argsDigest mismatch')
  })

  it('rejects expired approval timestamp outside ±5 min window (T05, T24)', async () => {
    const { pendingRegistry, rcpServer, deviceKeypair } = setupHost()

    const preview = { text: 'ls', json: '{}' }
    const argsDigest = computeArgsDigest(preview)
    const id = '55555555-5555-4555-8555-555555555555'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview,
      argsDigest,
      risk: 'high',
      requiresSignature: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
    })

    // 10 minutes in the past
    const expiredTimestamp = Date.now() - (10 * 60 * 1000)
    const canonicalMsg = buildCanonicalApprovalMessage({
      hostId,
      deviceId,
      sessionId: 'ses_1',
      toolName: 'bash',
      approvalId: id,
      outcome: 'allowed-once',
      issuedAt: expiredTimestamp,
      argsDigest,
    })
    const sig = encodeBase64Url(signApprovalMessage(deviceKeypair.privateKey, utf8ToBytes(canonicalMsg)))

    const res = await sendRpc(rcpServer, 'approvals.answer', {
      id,
      outcome: 'allowed-once',
      argsDigest,
      issuedAt: expiredTimestamp,
      sig,
    })

    expect(res.ok).toBe(false)
    expect(res.e?.message).toContain('issuedAt outside 5-minute window')
  })

  it('rejects replayed approval answer (T05, T24)', async () => {
    const { pendingRegistry, rcpServer } = setupHost()

    const preview = { text: 'cat readme.txt', json: '{}' }
    const argsDigest = computeArgsDigest(preview)
    const id = '66666666-6666-4666-8666-666666666666'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview,
      argsDigest,
      risk: 'normal',
      requiresSignature: false,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    // First answer -> accepted
    const res1 = await sendRpc(
      rcpServer,
      'approvals.answer',
      {
        id,
        outcome: 'allowed-once',
        argsDigest,
        issuedAt: Date.now(),
      },
      5,
    )
    expect(res1.ok).toBe(true)
    expect(res1.r).toMatchObject({
      accepted: true,
      final: 'allowed-once',
    })

    // Second answer for same id -> returns accepted: false (never executes twice)
    const res2 = await sendRpc(
      rcpServer,
      'approvals.answer',
      {
        id,
        outcome: 'rejected',
        argsDigest,
        issuedAt: Date.now(),
      },
      6,
    )
    expect(res2.ok).toBe(true)
    expect(res2.r).toMatchObject({
      accepted: false,
      final: 'allowed-once',
    })
  })

  it('rejects approval from revoked device (T09)', async () => {
    const { registry, pendingRegistry, rcpServer, deviceKeypair } = setupHost()

    const preview = { text: 'rm file.tmp', json: '{}' }
    const argsDigest = computeArgsDigest(preview)
    const id = '77777777-7777-4777-8777-777777777777'

    pendingRegistry.add({
      kind: 'approval',
      id,
      sessionId: 'ses_1',
      sessionTitle: 'Session 1',
      toolName: 'bash',
      preview,
      argsDigest,
      risk: 'high',
      requiresSignature: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })

    const canonicalMsg = buildCanonicalApprovalMessage({
      hostId,
      deviceId,
      sessionId: 'ses_1',
      toolName: 'bash',
      approvalId: id,
      outcome: 'allowed-once',
      issuedAt: Date.now(),
      argsDigest,
    })
    const sig = encodeBase64Url(signApprovalMessage(deviceKeypair.privateKey, utf8ToBytes(canonicalMsg)))

    // Revoke device on host
    registry.revokeDevice(deviceId)

    const res = await sendRpc(
      rcpServer,
      'approvals.answer',
      {
        id,
        outcome: 'allowed-once',
        argsDigest,
        issuedAt: Date.now(),
        sig,
      },
      7,
    )

    expect(res.ok).toBe(false)
    expect(res.e?.code).toBe('signature_invalid')
    expect(res.e?.message).toContain('revoked')
  })
})
