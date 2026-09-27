/**
 * Push payload construction and sealing (Crypto/1 §8, blueprint §8.10).
 *
 * Payloads are compact JSON with a fixed field order, redacted single-line
 * human text capped at 80 characters, and a hard 2,048-byte plaintext
 * budget. `sealPush` encrypts under the per-device push key, so the relay and
 * FCM only ever handle ciphertext (AGENTS §1.1, §1.8).
 */

import { encodeBase64Url, sealPushPayload } from '@remora/crypto'

/** Push kinds on the wire (Crypto/1 §8). */
export type PushKind = 'approval' | 'question' | 'turn_done' | 'turn_error'

export interface BuildPushPayloadOptions {
  /** Unix timestamp in ms; defaults to now. */
  at?: number | undefined
  /** Session the notification belongs to (all kinds). */
  sessionId?: string | undefined
  /** Pending approval/question id (`approval`, `question`). */
  pendingId?: string | undefined
  title: string
  body: string
}

/** Crypto/1 §8: the JSON plaintext must not exceed 2,048 bytes. */
const MAX_PAYLOAD_BYTES = 2_048

/** Human text (titles, command previews) is capped at 80 characters. */
const MAX_TEXT_CHARS = 80

const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g

/**
 * Secret patterns scrubbed from human text before it leaves the host: JWTs,
 * provider tokens, AWS key ids, Slack tokens, and `key: value` / `key=value`
 * credential assignments. Applied after PEM blocks are flattened.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:password|passwd|pwd|secret|token|api[_-]?key|api[_-]?secret|access[_-]?token|client[_-]?secret|private[_-]?key|authorization)\b\s*[:=]\s*['"]?[^\s'"<>&]+/gi,
]

/**
 * Builds the push payload (Crypto/1 §8): field order `v, kind, at, sessionId?,
 * pendingId?, title, body`. Title and body are flattened to one line, secret-
 * scrubbed, and truncated; the serialized result is guaranteed ≤ 2,048 bytes.
 */
export function buildPushPayload(kind: PushKind, options: BuildPushPayloadOptions): Record<string, unknown> {
  const title = truncateChars(sanitizeText(options.title), MAX_TEXT_CHARS)
  const body = truncateChars(sanitizeText(options.body), MAX_TEXT_CHARS)
  const payload: Record<string, unknown> = { v: 1, kind, at: options.at ?? Date.now() }
  if (options.sessionId !== undefined) payload.sessionId = options.sessionId
  if (options.pendingId !== undefined) payload.pendingId = options.pendingId
  payload.title = title
  payload.body = body
  enforcePayloadBudget(payload)
  return payload
}

/**
 * Seals a payload for one device: ChaCha20-Poly1305 under the device push key
 * (12-byte nonce prepended), unpadded base64url (Crypto/1 §8). Callers build
 * via `buildPushPayload`, which enforces the plaintext budget.
 */
export function sealPush(devicePushKey: Uint8Array, payload: unknown): string {
  return encodeBase64Url(sealPushPayload(devicePushKey, payload))
}

function sanitizeText(input: string): string {
  const flattened = input
    .replace(PEM_PRIVATE_KEY_PATTERN, ' [redacted] ')
    .replace(/\s+/gu, ' ')
    .trim()
  let text = flattened
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]')
  return text.replace(/\s+/gu, ' ').trim()
}

function truncateChars(text: string, maxChars: number): string {
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('')
}

function enforcePayloadBudget(payload: Record<string, unknown>): void {
  const body = payload.body
  if (typeof body !== 'string') return
  const overhead = utf8ByteLength(JSON.stringify({ ...payload, body: '' }))
  const budget = MAX_PAYLOAD_BYTES - overhead
  if (budget < 0) throw new Error(`push: payload overhead exceeds the ${MAX_PAYLOAD_BYTES}-byte budget`)
  if (utf8ByteLength(body) <= budget) return
  payload.body = truncateUtf8(body, budget)
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (utf8ByteLength(text) <= maxBytes) return text
  const encoder = new TextEncoder()
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return out
}
