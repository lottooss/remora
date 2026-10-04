/**
 * RCP method registration for the devices.* methods (RCP/1 §7) and the
 * approval-key rotation state they share with the management page: a device
 * requests a rotation over RCP, the PC confirms or rejects it on the
 * management page, and only then does the new key become active
 * (crypto-v1.md §10).
 *
 * `devices.self` and `devices.unpair` act on the CALLING device only (spec
 * §11: "self only") — the subject comes from the channel's authenticated
 * device id, never from parameters.
 */
import { createPublicKey } from 'node:crypto'
import { decodeBase64Url } from '@remora/crypto'
import {
  DevicesRotateApprovalKeyParamsSchema,
  DevicesSelfParamsSchema,
  DevicesUnpairParamsSchema,
  RCP_ERROR_CODES,
  createRcpError,
} from '@remora/protocol'
import type { DeviceRegistry } from '../../devices/index.ts'
import { RcpMethodError, type RcpServer } from '../index.ts'

/** How long a requested key rotation waits for its PC confirmation. */
export const ROTATION_PENDING_TTL_MS = 10 * 60_000

/** A key rotation a device requested and the PC has not resolved yet. */
export interface PendingApprovalKeyRotation {
  /** The device that requested the rotation. */
  deviceId: string
  /** Canonical P-256 SubjectPublicKeyInfo DER the device wants to activate. */
  approvalPublicKey: Uint8Array
  /** Exactly-once id of the rotation request (RCP/1 §11). */
  requestId: string
  requestedAt: number
  expiresAt: number
}

/** What a management-page resolution did with the pending rotation. */
export type RotationResolution = 'resolved' | 'no-pending'

export interface ApprovalKeyRotationOptions {
  /** Registry the confirmed key is activated (and persisted) through. */
  registry: DeviceRegistry
  /** Clock injection point so the pending TTL stays deterministic in tests. */
  now?: () => number
}

/**
 * The pending `devices.rotateApprovalKey` requests, shared between the RCP
 * handler (request) and the management routes (confirm/reject, see
 * src/web/routes.ts): the new key becomes active ONLY after the PC confirms
 * (crypto-v1.md §10).
 *
 * Activation goes through the registry's `addDevice` upsert — the same atomic
 * whole-record credentials write every registry change uses — so the activated
 * key survives a host restart with the rest of the device record. One pending
 * rotation per device: a retry of the same `requestId` is the same request
 * (exactly-once), a different one conflicts until the PC resolves the open
 * rotation. Expired entries are swept lazily on access (no timers).
 */
export class ApprovalKeyRotationManager {
  private readonly pending = new Map<string, PendingApprovalKeyRotation>()
  private readonly registry: DeviceRegistry
  private readonly now: () => number

  constructor(options: ApprovalKeyRotationOptions) {
    this.registry = options.registry
    this.now = options.now ?? Date.now
  }

  /** The live pending rotations, oldest first (expired ones dropped). */
  listPending(): PendingApprovalKeyRotation[] {
    this.sweepExpired()
    return [...this.pending.values()].sort((a, b) => a.requestedAt - b.requestedAt)
  }

  /**
   * Records a rotation request. A retry with the same `requestId` reports
   * `duplicate`; a different request while one is still pending reports
   * `conflict` — the device must wait for the PC to resolve the open one.
   */
  request(
    deviceId: string,
    approvalPublicKey: Uint8Array,
    requestId: string,
  ): { kind: 'pending' } | { kind: 'duplicate' } | { kind: 'conflict' } {
    this.sweepExpired()
    const existing = this.pending.get(deviceId)
    if (existing !== undefined) {
      return existing.requestId === requestId ? { kind: 'duplicate' } : { kind: 'conflict' }
    }
    const requestedAt = this.now()
    this.pending.set(deviceId, {
      deviceId,
      approvalPublicKey,
      requestId,
      requestedAt,
      expiresAt: requestedAt + ROTATION_PENDING_TTL_MS,
    })
    return { kind: 'pending' }
  }

  /**
   * Activates the pending key: the device record is re-added with the new
   * approval public key, which persists it in the same atomic write as every
   * other registry change. Fails closed (`no-pending`) when the device went
   * away or was revoked meanwhile — the pending entry is dropped either way;
   * a revoked device never activates a key.
   */
  confirm(deviceId: string): RotationResolution {
    const pending = this.takePending(deviceId)
    if (pending === null) return 'no-pending'
    const device = this.registry.getDeviceById(deviceId)
    if (device === null || device.revoked) return 'no-pending'
    this.registry.addDevice({ ...device, approvalPublicKey: pending.approvalPublicKey })
    return 'resolved'
  }

  /** Drops the pending rotation without activating anything. */
  reject(deviceId: string): RotationResolution {
    return this.takePending(deviceId) === null ? 'no-pending' : 'resolved'
  }

  /** Removes and returns the live pending entry for `deviceId`, if any. */
  private takePending(deviceId: string): PendingApprovalKeyRotation | null {
    this.sweepExpired()
    const pending = this.pending.get(deviceId) ?? null
    if (pending !== null) this.pending.delete(deviceId)
    return pending
  }

  private sweepExpired(): void {
    const now = this.now()
    for (const [deviceId, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(deviceId)
    }
  }
}

/** Dependencies of the devices.* methods; apply() wires the real services. */
export interface DevicesMethodsDeps {
  registry: DeviceRegistry
  /** Pending approval-key rotations shared with the management page. */
  rotations: ApprovalKeyRotationManager
  /**
   * Schedules the relay-side endpoint revoke of a self-unpairing device
   * (crypto-v1.md §10) for after the unpair reply has been queued to the
   * relay — see apply() in src/index.ts for why the revoke must be deferred.
   */
  scheduleRelayRevoke?: ((deviceId: string) => void) | undefined
}

/** id-ecPublicKey + prime256v1 AlgorithmIdentifier and uncompressed BIT STRING. */
const P256_SPKI_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')

/**
 * Android exports SPKI; early rotation clients sent uncompressed SEC1. Import
 * either with OpenSSL's curve/point validation and persist the SPKI format
 * consumed by verifyApprovalSignature, never an unchecked 65-byte point.
 */
function normalizeApprovalPublicKey(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 0 || bytes.length > 512) throw new Error('invalid approval public key')
  const input = bytes.length === 65 && bytes[0] === 0x04
    ? Buffer.concat([P256_SPKI_PREFIX, bytes])
    : Buffer.from(bytes)
  const key = createPublicKey({ key: input, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('approval public key must use P-256')
  }
  // Reject trailing bytes and non-canonical ASN.1 rather than letting the parser
  // silently discard data. Importing the JWK normalizes compressed points too.
  const encoded = key.export({ format: 'der', type: 'spki' })
  if (!encoded.equals(input)) throw new Error('approval public key must be canonical DER')
  const canonicalKey = createPublicKey({ key: key.export({ format: 'jwk' }), format: 'jwk' })
  return new Uint8Array(canonicalKey.export({ format: 'der', type: 'spki' }))
}

export function registerDevicesMethods(rcpServer: RcpServer, deps: DevicesMethodsDeps): void {
  rcpServer.registerMethod('devices.self', async (p, ctx) => {
    const parsed = DevicesSelfParamsSchema.safeParse(p ?? {})
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid devices.self params'))
    }
    const device = deps.registry.getDeviceById(ctx.deviceId)
    // Session admission already refuses unpaired and revoked devices; this is
    // the fail-closed defense for a record that vanished mid-session.
    if (device === null || device.revoked) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.forbidden, 'device is not paired'))
    }
    return {
      id: device.deviceId,
      name: device.name,
      pairedAt: device.createdAt,
      // Whether the phone's approval key is hardware-backed is only observable
      // on the phone; the host reports "unknown" (RCP/1 §7 allows null).
      approvalKey: { hardwareBacked: null },
    }
  })

  rcpServer.registerMethod('devices.unpair', async (p, ctx) => {
    const parsed = DevicesUnpairParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid devices.unpair params'))
    }
    const device = deps.registry.getDeviceById(ctx.deviceId)
    if (device === null || device.revoked) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.forbidden, 'device is not paired'))
    }
    // The authoritative half (crypto-v1.md §10): the registry's revocation
    // path marks the device revoked and drops its PSK, push key, and
    // preferences in one atomic credentials write, then fires the on-revoke
    // hook that apply() wired to the channel manager — the device's channels
    // close (this one included) right after the `{ ok: true }` reply below is
    // encoded, which is the order RCP/1 §7 specifies.
    deps.registry.revokeDevice(ctx.deviceId)
    // A revoked endpoint's frames are dropped by the relay, so the relay-side
    // revoke must be queued only after the reply; apply() defers it.
    deps.scheduleRelayRevoke?.(ctx.deviceId)
    return { ok: true as const }
  })

  rcpServer.registerMethod('devices.rotateApprovalKey', async (p, ctx) => {
    const parsed = DevicesRotateApprovalKeyParamsSchema.safeParse(p)
    if (!parsed.success) {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'invalid devices.rotateApprovalKey params'),
      )
    }
    const device = deps.registry.getDeviceById(ctx.deviceId)
    if (device === null || device.revoked) {
      throw new RcpMethodError(createRcpError(RCP_ERROR_CODES.forbidden, 'device is not paired'))
    }
    let approvalPublicKey: Uint8Array
    try {
      approvalPublicKey = normalizeApprovalPublicKey(decodeBase64Url(parsed.data.approvalPub))
    } catch {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.invalid_params, 'approvalPub must encode a valid P-256 public key'),
      )
    }
    const outcome = deps.rotations.request(ctx.deviceId, approvalPublicKey, parsed.data.requestId)
    if (outcome.kind === 'conflict') {
      throw new RcpMethodError(
        createRcpError(RCP_ERROR_CODES.conflict, 'a key rotation is already awaiting PC confirmation'),
      )
    }
    // Both 'pending' and 'duplicate' (a retry of the same requestId) answer
    // with the same status: the key is NOT active until the PC confirms
    // (crypto-v1.md §10).
    return { status: 'pending_pc_confirmation' as const }
  })
}
