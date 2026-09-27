/**
 * Policy Guard for Remora Host (ADR-0007, blueprint §8.7).
 * Unifies path containment, deterministic risk classification,
 * biometric signature verification, and per-device rate limiting.
 */
import type { RcpError } from '@remora/protocol'
import {
  canonicalize,
  contains,
  resolveRoots,
} from './paths.ts'
import {
  classifyRisk,
  type ApprovalRisk,
  type RiskClassificationContext,
} from './risk.ts'
import {
  SingleUseApprovalStore,
  verifyAnswerSignaturePolicy,
  type SignatureVerificationResult,
  type VerifyApprovalParams,
} from './signature.ts'
import {
  DeviceRateLimiter,
} from './limits.ts'

export * from './paths.ts'
export * from './risk.ts'
export * from './signature.ts'
export * from './limits.ts'

export interface PolicyGuardOptions {
  remoteRoots?: readonly string[]
  allowRemoteSessionStart?: boolean
  approvalBiometric?: 'high' | 'all' | 'never'
  approvalAuth?: 'biometric' | 'biometric-or-credential'
  now?: () => number
}

export interface PolicyGuard {
  readonly remoteRoots: readonly string[]
  readonly allowRemoteSessionStart: boolean
  readonly approvalBiometric: 'high' | 'all' | 'never'
  readonly approvalAuth: 'biometric' | 'biometric-or-credential'

  canonicalizePath(rawPath: string): string
  isPathContained(root: string, candidate: string): boolean
  checkPathAccess(candidatePath: string, allowedRoots?: readonly string[]): boolean
  classifyRisk(toolName: string, args: unknown, context?: RiskClassificationContext): ApprovalRisk
  verifyApprovalSignature(params: Omit<VerifyApprovalParams, 'approvalBiometric'>): SignatureVerificationResult
  checkRateLimit(deviceId: string, method: string): { ok: boolean; error?: RcpError }
  acquireStreamSlot(deviceId: string): { ok: boolean; error?: RcpError; release: () => void }
}

export class DefaultPolicyGuard implements PolicyGuard {
  readonly remoteRoots: readonly string[]
  readonly allowRemoteSessionStart: boolean
  readonly approvalBiometric: 'high' | 'all' | 'never'
  readonly approvalAuth: 'biometric' | 'biometric-or-credential'

  private readonly rateLimiter: DeviceRateLimiter
  private readonly singleUseStore: SingleUseApprovalStore
  private readonly now: () => number

  constructor(options?: PolicyGuardOptions) {
    this.remoteRoots = Object.freeze(resolveRoots(options?.remoteRoots ?? []))
    this.allowRemoteSessionStart = options?.allowRemoteSessionStart ?? true
    this.approvalBiometric = options?.approvalBiometric ?? 'high'
    this.approvalAuth = options?.approvalAuth ?? 'biometric'
    this.now = options?.now ?? Date.now
    this.rateLimiter = new DeviceRateLimiter({ now: this.now })
    this.singleUseStore = new SingleUseApprovalStore()
  }

  canonicalizePath(rawPath: string): string {
    return canonicalize(rawPath)
  }

  isPathContained(root: string, candidate: string): boolean {
    return contains(root, candidate)
  }

  /**
   * Checks whether candidatePath is contained within any of the allowed roots.
   * If allowedRoots is not provided, defaults to this.remoteRoots.
   */
  checkPathAccess(candidatePath: string, allowedRoots?: readonly string[]): boolean {
    const roots = allowedRoots ?? this.remoteRoots
    if (roots.length === 0) return false

    for (const root of roots) {
      if (this.isPathContained(root, candidatePath)) {
        return true
      }
    }
    return false
  }

  classifyRisk(toolName: string, args: unknown, context?: RiskClassificationContext): ApprovalRisk {
    return classifyRisk(toolName, args, context)
  }

  verifyApprovalSignature(
    params: Omit<VerifyApprovalParams, 'approvalBiometric'>,
  ): SignatureVerificationResult {
    return verifyAnswerSignaturePolicy(
      {
        ...params,
        approvalBiometric: this.approvalBiometric,
        now: params.now ?? this.now(),
      },
      this.singleUseStore,
    )
  }

  checkRateLimit(deviceId: string, method: string): { ok: boolean; error?: RcpError } {
    return this.rateLimiter.checkRequest(deviceId, method)
  }

  acquireStreamSlot(deviceId: string): { ok: boolean; error?: RcpError; release: () => void } {
    return this.rateLimiter.acquireStream(deviceId)
  }
}
