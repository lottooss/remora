import { z } from 'zod'

/**
 * Peer status object in ready and presence frames.
 */
export const PeerSchema = z.object({
  id: z.string(),
  kind: z.enum(['host', 'device']),
  name: z.string(),
  online: z.boolean(),
  lastSeenAt: z.number().int().nonnegative(),
}).passthrough()

export type Peer = z.infer<typeof PeerSchema>

// Challenge frame: R -> C
export const ChallengeFrameSchema = z.object({
  t: z.literal('challenge'),
  v: z.literal(1),
  nonce: z.string(),
  time: z.number().int().nonnegative(),
}).passthrough()

export type ChallengeFrame = z.infer<typeof ChallengeFrameSchema>

// Auth frame: C -> R
export const AuthFrameSchema = z.object({
  t: z.literal('auth'),
  v: z.literal(1),
  kind: z.enum(['host', 'device']),
  id: z.string(),
  sig: z.string(),
  app: z.string().optional(),
}).passthrough()

export type AuthFrame = z.infer<typeof AuthFrameSchema>

// Ready frame: R -> C
export const ReadyFrameSchema = z.object({
  t: z.literal('ready'),
  v: z.literal(1),
  id: z.string(),
  peers: z.array(PeerSchema),
  limits: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export type ReadyFrame = z.infer<typeof ReadyFrameSchema>

// Ping frame: C -> R
export const PingFrameSchema = z.object({
  t: z.literal('ping'),
}).passthrough()

export type PingFrame = z.infer<typeof PingFrameSchema>

// Pong frame: R -> C
export const PongFrameSchema = z.object({
  t: z.literal('pong'),
}).passthrough()

export type PongFrame = z.infer<typeof PongFrameSchema>

// Presence frame: R -> C
export const PresenceFrameSchema = z.object({
  t: z.literal('presence'),
  id: z.string(),
  kind: z.enum(['host', 'device']),
  online: z.boolean(),
  at: z.number().int().nonnegative(),
}).passthrough()

export type PresenceFrame = z.infer<typeof PresenceFrameSchema>

// Enroll ticket request: Host -> R
export const EnrollTicketRequestSchema = z.object({
  t: z.literal('enroll.ticket'),
  rid: z.string().max(32),
}).passthrough()

export type EnrollTicketRequest = z.infer<typeof EnrollTicketRequestSchema>

// Enroll ticket response: R -> Host
export const EnrollTicketResponseSchema = z.object({
  t: z.literal('enroll.ticket.ok'),
  rid: z.string().max(32),
  ticket: z.string(),
  expiresAt: z.number().int().nonnegative(),
}).passthrough()

export type EnrollTicketResponse = z.infer<typeof EnrollTicketResponseSchema>

// Endpoint list request: Host -> R
export const EndpointListRequestSchema = z.object({
  t: z.literal('endpoint.list'),
  rid: z.string().max(32),
}).passthrough()

export type EndpointListRequest = z.infer<typeof EndpointListRequestSchema>

// Endpoint list response: R -> Host
export const EndpointListResponseSchema = z.object({
  t: z.literal('endpoint.list.ok'),
  rid: z.string().max(32),
  devices: z.array(PeerSchema),
}).passthrough()

export type EndpointListResponse = z.infer<typeof EndpointListResponseSchema>

// Endpoint revoke request: C -> R
export const EndpointRevokeRequestSchema = z.object({
  t: z.literal('endpoint.revoke'),
  rid: z.string().max(32),
  id: z.string(),
}).passthrough()

export type EndpointRevokeRequest = z.infer<typeof EndpointRevokeRequestSchema>

// Push request: Host -> R
export const PushRequestSchema = z.object({
  t: z.literal('push'),
  rid: z.string().max(32),
  to: z.array(z.string()),
  ct: z.string().max(3072),
  collapse: z.string().optional(),
  priority: z.enum(['high', 'normal']).default('normal'),
  ttl: z.number().int().min(0).max(86400).default(86400),
}).passthrough()

export type PushRequest = z.infer<typeof PushRequestSchema>

// Push result item
export const PushResultItemSchema = z.object({
  id: z.string(),
  status: z.enum(['sent', 'no_token', 'unregistered', 'error']),
}).passthrough()

export type PushResultItem = z.infer<typeof PushResultItemSchema>

// Push response: R -> Host
export const PushResponseSchema = z.object({
  t: z.literal('push.result'),
  rid: z.string().max(32),
  results: z.array(PushResultItemSchema),
}).passthrough()

export type PushResponse = z.infer<typeof PushResponseSchema>

// Push token update: Device -> R
export const PushTokenRequestSchema = z.object({
  t: z.literal('push.token'),
  rid: z.string().max(32),
  token: z.string(),
  hostOffline: z.boolean(),
}).passthrough()

export type PushTokenRequest = z.infer<typeof PushTokenRequestSchema>

// Bye frame: C -> R
export const ByeFrameSchema = z.object({
  t: z.literal('bye'),
  reason: z.string().optional(),
}).passthrough()

export type ByeFrame = z.infer<typeof ByeFrameSchema>

// Ok response: R -> C
export const OkResponseSchema = z.object({
  t: z.literal('ok'),
  rid: z.string().max(32),
}).passthrough()

export type OkResponse = z.infer<typeof OkResponseSchema>

// Error response: R -> C
export const ErrorResponseSchema = z.object({
  t: z.literal('error'),
  rid: z.string().max(32).optional(),
  code: z.string(),
  message: z.string(),
  ref: z.string().optional(),
}).passthrough()

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

// Union of all control frames
export const ControlFrameSchema = z.union([
  ChallengeFrameSchema,
  AuthFrameSchema,
  ReadyFrameSchema,
  PingFrameSchema,
  PongFrameSchema,
  PresenceFrameSchema,
  EnrollTicketRequestSchema,
  EnrollTicketResponseSchema,
  EndpointListRequestSchema,
  EndpointListResponseSchema,
  EndpointRevokeRequestSchema,
  PushRequestSchema,
  PushResponseSchema,
  PushTokenRequestSchema,
  ByeFrameSchema,
  OkResponseSchema,
  ErrorResponseSchema,
])

export type ControlFrame = z.infer<typeof ControlFrameSchema>
