/**
 * Signature verification and single-use enforcement for Policy Guard (ADR-0007, Crypto/1 §7).
 */
import {
  type ApprovalOutcome,
  buildCanonicalApprovalMessage,
  decodeBase64Url,
  utf8ToBytes,
  verifyApprovalSignature,
} from '@remora/crypto'
import type { ApprovalRisk } from './risk.ts'

/** Allowed clock drift window: +/- 5 minutes. */
export const APPROVAL_FRESHNESS_WINDOW_MS = 5 * 60 * 1000

export interface VerifyApprovalParams {
  approvalId: string
  outcome: ApprovalOutcome
  argsDigest: string
  expectedArgsDigest: string
  issuedAt: number
  risk: ApprovalRisk
  approvalBiometric: 'high' | 'all' | 'never'
  approvalPublicKey?: Uint8Array | null | undefined
  sig?: string | undefined
  now?: number | undefined
}

export interface SignatureVerificationResult {
  ok: boolean
  error?: 'signature_required' | 'signature_invalid' | 'expired' | 'digest_mismatch' | 'already_used' | undefined
  reason?: string | undefined
}

/**
 * Tracks used approval IDs to prevent replay attacks (Threat model T05, T24).
 */
export class SingleUseApprovalStore {
  private readonly used = new Map<string, number>()
  private readonly ttlMs: number

  constructor(ttlMs = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs
  }

  isUsed(approvalId: string): boolean {
    return this.used.has(approvalId)
  }

  markUsed(approvalId: string, now = Date.now()): boolean {
    if (this.used.has(approvalId)) {
      return false
    }
    this.used.set(approvalId, now)
    this.prune(now)
    return true
  }

  private prune(now: number): void {
    if (this.used.size > 10_000) {
      for (const [id, time] of this.used.entries()) {
        if (now - time > this.ttlMs) {
          this.used.delete(id)
        }
      }
    }
  }

  clear(): void {
    this.used.clear()
  }
}

/**
 * Verifies an approval answer against policy, freshness, digest matching, and P-256 signature.
 */
export function verifyAnswerSignaturePolicy(
  params: VerifyApprovalParams,
  singleUseStore?: SingleUseApprovalStore,
): SignatureVerificationResult {
  const {
    approvalId,
    outcome,
    argsDigest,
    expectedArgsDigest,
    issuedAt,
    risk,
    approvalBiometric,
    approvalPublicKey,
    sig,
    now = Date.now(),
  } = params

  // 1. Single-use check
  if (singleUseStore?.isUsed(approvalId)) {
    return {
      ok: false,
      error: 'already_used',
      reason: `Approval ${approvalId} has already been resolved or answered`,
    }
  }

  // 2. Digest check
  if (argsDigest !== expectedArgsDigest) {
    return {
      ok: false,
      error: 'digest_mismatch',
      reason: `argsDigest mismatch: expected ${expectedArgsDigest}, got ${argsDigest}`,
    }
  }

  // 3. Freshness check: |issuedAt - hostNow| <= 5 minutes
  if (Math.abs(now - issuedAt) > APPROVAL_FRESHNESS_WINDOW_MS) {
    return {
      ok: false,
      error: 'expired',
      reason: `issuedAt ${issuedAt} is outside the allowed +/- 5 minute window relative to host ${now}`,
    }
  }

  // 4. Signature requirement determination
  const signatureRequired =
    approvalBiometric === 'all' || (approvalBiometric === 'high' && risk === 'high')

  if (signatureRequired) {
    if (!sig) {
      return {
        ok: false,
        error: 'signature_required',
        reason: `Biometric signature required for ${risk}-risk approval (approvalBiometric=${approvalBiometric})`,
      }
    }

    if (!approvalPublicKey || approvalPublicKey.length === 0) {
      return {
        ok: false,
        error: 'signature_invalid',
        reason: 'Device has no registered approval public key',
      }
    }

    let sigBytes: Uint8Array
    try {
      sigBytes = decodeBase64Url(sig)
    } catch {
      return {
        ok: false,
        error: 'signature_invalid',
        reason: 'Signature is not valid base64url',
      }
    }

    let canonicalMsg: string
    try {
      canonicalMsg = buildCanonicalApprovalMessage({
        approvalId,
        outcome,
        issuedAt,
        argsDigest,
      })
    } catch (err) {
      return {
        ok: false,
        error: 'signature_invalid',
        reason: `Canonical message construction failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    const valid = verifyApprovalSignature(approvalPublicKey, sigBytes, utf8ToBytes(canonicalMsg))
    if (!valid) {
      return {
        ok: false,
        error: 'signature_invalid',
        reason: 'P-256 ECDSA signature verification failed',
      }
    }
  }

  // Mark as used if verification passed
  if (singleUseStore) {
    singleUseStore.markUsed(approvalId, now)
  }

  return { ok: true }
}
