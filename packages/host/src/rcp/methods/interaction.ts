import {
  ApprovalsAnswerParamsSchema,
  InteractionFollowParamsSchema,
  QuestionsAnswerParamsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import {
  buildCanonicalApprovalMessage,
  decodeBase64Url,
  utf8ToBytes,
  verifyApprovalSignature,
} from '@remora/crypto'
import type { DeviceRegistry } from '../../devices/index.ts'
import type { PendingRegistry } from '../../interaction/pending.ts'
import type { PolicyGuard } from '../../policy/index.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

export function registerInteractionMethods(
  rcpServer: RcpServer,
  pendingRegistry: PendingRegistry,
  deviceRegistry: DeviceRegistry,
  policyGuard?: PolicyGuard | undefined,
): void {
  // 1. interaction.follow (stream)
  rcpServer.registerMethod('interaction.follow', async (p, ctx) => {
    const parsed = InteractionFollowParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid interaction.follow params'))
    }
    if (!ctx.stream) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.internal_error, 'stream sink unavailable'))
    }

    const sink = ctx.stream

    // Send baseline snapshot
    await sink.sendItem({
      type: 'baseline',
      pending: pendingRegistry.list(),
    })

    // Subscribe to live deltas
    const unsubscribe = pendingRegistry.subscribe(async (event) => {
      if (sink.signal.aborted) return
      try {
        await sink.sendItem(event as Record<string, unknown>)
      } catch {
        // stream write error
      }
    })

    sink.signal.addEventListener(
      'abort',
      () => {
        unsubscribe()
      },
      { once: true },
    )

    return {}
  })

  // 2. approvals.answer (unary, mutating)
  rcpServer.registerMethod('approvals.answer', async (p, ctx) => {
    const parsed = ApprovalsAnswerParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid approvals.answer params'))
    }

    const item = pendingRegistry.get(parsed.data.id)
    if (!item || item.kind !== 'approval') {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.not_found, `approval '${parsed.data.id}' not found`))
    }

    // Single-use: already resolved -> return accepted: false with winning by
    if (item.resolved && item.resolution) {
      return {
        accepted: false,
        final: item.resolution.outcome,
        by: item.resolution.by,
      }
    }

    // argsDigest check
    if (item.argsDigest !== parsed.data.argsDigest) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'argsDigest mismatch'))
    }

    // Signature verification (Crypto/1 §7)
    if (item.requiresSignature) {
      if (!parsed.data.sig) {
        throw new RcpMethodError(
          createRcpError('signature_required', 'biometric signature required for high-risk approval'),
        )
      }

      const device = deviceRegistry.getDeviceById(ctx.deviceId)
      if (!device || device.revoked || !device.approvalPublicKey) {
        throw new RcpMethodError(
          createRcpError('signature_invalid', 'device has no approval public key registered or is revoked'),
        )
      }

      // Check issuedAt window: +/- 5 minutes
      const now = Date.now()
      if (Math.abs(now - parsed.data.issuedAt) > 300_000) {
        throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'issuedAt outside 5-minute window'))
      }

      // If policyGuard provided custom verification, call it
      if (policyGuard?.verifyApprovalSignature) {
        const verifyRes = policyGuard.verifyApprovalSignature({
          approvalId: parsed.data.id,
          outcome: parsed.data.outcome,
          argsDigest: parsed.data.argsDigest,
          expectedArgsDigest: item.argsDigest,
          issuedAt: parsed.data.issuedAt,
          sig: parsed.data.sig,
          approvalPublicKey: device.approvalPublicKey,
          risk: item.risk,
          now,
        })
        if (!verifyRes.ok) {
          throw new RcpMethodError(createRcpError('signature_invalid', verifyRes.reason ?? 'signature verification failed'))
        }
      } else {
        const canonicalMsg = buildCanonicalApprovalMessage({
          approvalId: parsed.data.id,
          outcome: parsed.data.outcome,
          argsDigest: parsed.data.argsDigest,
          issuedAt: parsed.data.issuedAt,
        })

        let sigBytes: Uint8Array
        try {
          sigBytes = decodeBase64Url(parsed.data.sig)
        } catch {
          throw new RcpMethodError(createRcpError('signature_invalid', 'invalid signature base64url encoding'))
        }

        const valid = verifyApprovalSignature(device.approvalPublicKey, sigBytes, utf8ToBytes(canonicalMsg))
        if (!valid) {
          throw new RcpMethodError(createRcpError('signature_invalid', 'signature verification failed'))
        }
      }
    }

    return pendingRegistry.resolveApproval(parsed.data.id, parsed.data.outcome, 'phone', ctx.deviceId)
  })

  // 3. questions.answer (unary, mutating)
  rcpServer.registerMethod('questions.answer', async (p, ctx) => {
    const parsed = QuestionsAnswerParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid questions.answer params'))
    }

    const item = pendingRegistry.get(parsed.data.id)
    if (!item || item.kind !== 'question') {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.not_found, `question '${parsed.data.id}' not found`))
    }

    if (item.resolved && item.resolution) {
      return {
        accepted: false,
        by: item.resolution.by,
      }
    }

    return pendingRegistry.resolveQuestion(parsed.data.id, parsed.data.answers, 'phone', ctx.deviceId)
  })
}
