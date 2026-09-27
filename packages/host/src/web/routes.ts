/**
 * The PC-side management surface: exact Fetch routes below `/api/remora` on the
 * dsh web origin, plus the trailing-slash alias the runbook hands out.
 *
 * Connection already applies its Host/Origin fence and browser-cookie
 * authentication to every request that reaches these routes, so the page is
 * protected for free; each handler still repeats a same-origin check here so a
 * cross-site POST is refused at this layer too, independently of which carrier
 * mounted the route.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { DeviceRegistry } from '../devices/index.ts'
import {
  generateQrSvg,
  printTerminalQr,
  renderDashboardHtml,
  type ManagementContext,
  type ManagementDashboardData,
  type TerminalQrStream,
} from './index.ts'

/** Request-header view shared by the alias route and the same-origin check. */
type ManagementRequestHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>

/** One exact Fetch route on dsh's shared `/api` channel. */
export interface ManagementFetchRoute {
  /** Absolute pathname below `/api`, no trailing slash. */
  readonly path: string
  /** HTTP methods this route owns; other methods fall through to shared-channel dispatch. */
  readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
  /** How the node:http bridge hands the body to `fetch`. */
  readonly requestBody: 'buffered' | 'streaming'
  /** Handles one request after Connection applied its trust and auth policy. */
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * The `ctx.connection` members these routes call, structurally typed so that
 * `@deepseek-ai/*` stays a peer-only, type-only dependency of this package.
 */
export interface ManagementConnection {
  /** Exact-route registry on the shared `/api` channel. */
  readonly fetch: { register(route: ManagementFetchRoute): () => Promise<void> }
  /** Connection's Host/Origin fence plus browser-cookie check (401/403, or undefined to proceed). */
  requestRejection(request: { readonly headers: ManagementRequestHeaders }): 401 | 403 | undefined
}

/** The `ctx.webServer` member the trailing-slash alias needs. */
export interface ManagementWebServer {
  /** Registers one exact-path node:http route; duplicate paths throw. */
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Everything the management routes need beyond the Cordis context. */
export interface ManagementRouteDeps extends ManagementContext {
  /** Revokes the device's relay endpoint after the local revoke; a failure answers 502. */
  revokeEndpointOnRelay?: (deviceId: string) => Promise<void>
  /** Terminal sink for the printed pairing QR; defaults to `process.stdout`. */
  terminalStdout?: TerminalQrStream
}

/** Canonical management pathname (the trailing-slash alias redirects here). */
const DASHBOARD_PATH = '/api/remora'
/** Runbook alias: `http://127.0.0.1:<port>/api/remora/`. */
const DASHBOARD_ALIAS_PATH = '/api/remora/'
/** Upper bound for one action body; larger requests answer 413. */
const MAX_ACTION_BODY_BYTES = 8 * 1024
/** Device endpoint id: `d_` plus 26 lowercase base32 characters (Crypto/1 §2). */
const DEVICE_ID_PATTERN = /^d_[a-z2-7]{26}$/
/** The six-digit SAS id the page echoes back for confirmation. */
const SAS_PATTERN = /^\d{6}$/

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/** Fetch handlers for the five management routes, already origin-guarded. */
interface ManagementHandlers {
  dashboard: (request: Request) => Promise<Response>
  pairStart: (request: Request) => Promise<Response>
  pairConfirm: (request: Request) => Promise<Response>
  pairReject: (request: Request) => Promise<Response>
  deviceRevoke: (request: Request) => Promise<Response>
}

/** Parsed action body, or the error response that refused it. */
type ActionBody = { ok: true; fields: Record<string, string> } | { ok: false; response: Response }

/**
 * Mounts the management page and its actions on the running dsh host.
 *
 * Registration happens as Cordis effects: the Fetch routes appear once the
 * `connection` service is available, and the trailing-slash alias once
 * `webServer` is available as well, so both orders of arrival work and every
 * contribution disappears with the caller's fiber.
 * @param ctx - owning plugin context.
 * @param deps - pairing, registry, relay, and identity state the routes render.
 */
export function registerManagementRoutes(ctx: Context, deps: ManagementRouteDeps): void {
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.get('connection') as unknown as ManagementConnection
    connectionCtx.effect(
      () => registerFetchRoutes(connectionCtx, connection, deps),
      'remora: /api/remora fetch routes',
    )
  })
  ctx.inject(['connection', 'webServer'], (aliasCtx) => {
    const connection = aliasCtx.get('connection') as unknown as ManagementConnection
    const webServer = aliasCtx.get('webServer') as unknown as ManagementWebServer | undefined
    if (webServer === undefined) return
    aliasCtx.effect(() => registerAliasRoute(connection, webServer), 'remora: /api/remora/ alias')
  })
}

/**
 * Registers the five exact Fetch routes and returns their combined disposer.
 * @param ctx - context used for failure logging.
 * @param connection - Connection fetch registry.
 * @param deps - route state.
 * @returns disposer removing every route.
 */
function registerFetchRoutes(
  ctx: Context,
  connection: ManagementConnection,
  deps: ManagementRouteDeps,
): () => Promise<void> {
  const handlers = createHandlers(ctx, deps)
  const disposers = [
    connection.fetch.register({
      path: DASHBOARD_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: handlers.dashboard,
    }),
    connection.fetch.register({
      path: `${DASHBOARD_PATH}/pair/start`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handlers.pairStart,
    }),
    connection.fetch.register({
      path: `${DASHBOARD_PATH}/pair/confirm`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handlers.pairConfirm,
    }),
    connection.fetch.register({
      path: `${DASHBOARD_PATH}/pair/reject`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handlers.pairReject,
    }),
    connection.fetch.register({
      path: `${DASHBOARD_PATH}/devices/revoke`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handlers.deviceRevoke,
    }),
  ]
  return async () => {
    await Promise.all(disposers.map((dispose) => dispose()))
  }
}

/**
 * Registers the runbook's trailing-slash URL as a redirect to the canonical
 * route. It cannot live on the shared `/api` channel (`endpointFromPath`
 * rejects the empty final segment), so it mounts on the web server directly
 * and applies Connection's trust fence itself.
 * @param connection - Connection trust fence.
 * @param webServer - web server route registry.
 * @returns disposer removing the alias.
 */
function registerAliasRoute(connection: ManagementConnection, webServer: ManagementWebServer): () => void {
  return webServer.register({
    kind: 'exact',
    path: DASHBOARD_ALIAS_PATH,
    handler: (req, res) => {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      res.writeHead(303, { location: DASHBOARD_PATH, 'cache-control': 'no-store' })
      res.end()
    },
  })
}

/**
 * Builds the origin-guarded handlers for the five routes.
 * @param ctx - context used for failure logging.
 * @param deps - route state.
 * @returns the handler map handed to Connection.
 */
function createHandlers(ctx: Context, deps: ManagementRouteDeps): ManagementHandlers {
  const guard =
    (handle: (request: Request) => Promise<Response>) =>
    async (request: Request): Promise<Response> => {
      const denial = denyCrossOrigin(request)
      if (denial !== undefined) return denial
      try {
        return await handle(request)
      } catch (error) {
        ctx.logger.warn(
          'remora: management route failed: %s',
          error instanceof Error ? error.message : 'unknown',
        )
        return jsonResponse(500, { error: 'internal-error' })
      }
    }

  return {
    dashboard: guard(async (request) => {
      const attempt = deps.pairingService.getActiveAttempt()
      const qrSvg =
        attempt !== null && attempt.state === 'awaiting_handshake'
          ? await generateQrSvg(attempt.qrPayload)
          : undefined
      const activePairing: ManagementDashboardData['activePairing'] =
        attempt === null
          ? null
          : {
              ...(attempt.sasCode === undefined ? {} : { sasCode: attempt.sasCode }),
              expiresAt: attempt.expiresAt,
              state: attempt.state,
            }
      const data: ManagementDashboardData = {
        hostId: deps.identity.hostId,
        hostName: deps.hostName,
        relayStatus: deps.relayConnection.status,
        devices: deps.registry.listDevices().map((device) => ({
          deviceId: device.deviceId,
          name: device.name,
          pairedAt: device.createdAt,
          revoked: device.revoked,
        })),
        activePairing,
        ...(qrSvg === undefined ? {} : { qrSvg }),
      }
      if (prefersHtml(request)) {
        return new Response(renderDashboardHtml(data), { status: 200, headers: HTML_HEADERS })
      }
      return jsonResponse(200, {
        hostId: data.hostId,
        hostName: data.hostName,
        relay: { status: data.relayStatus, connected: deps.relayConnection.isConnected },
        devices: data.devices,
        pairing:
          activePairing === null
            ? null
            : {
                state: activePairing.state,
                expiresAt: activePairing.expiresAt,
                ...(activePairing.sasCode === undefined ? {} : { sas: activePairing.sasCode }),
              },
      })
    }),

    pairStart: guard(async (request) => {
      const body = await readActionBody(request)
      if (!body.ok) return body.response
      if (deps.pairingService.hasActiveAttempt()) {
        return jsonResponse(409, { error: 'pairing-in-progress' })
      }
      const pairedDeviceCount = countPairedDevices(deps.registry)
      const attempt = await deps.pairingService.beginPairing()
      const printed = await printTerminalQr(attempt.qrPayload, {
        pairedDeviceCount,
        ...(deps.terminalStdout === undefined ? {} : { stdout: deps.terminalStdout }),
      })
      ctx.logger.debug('remora: terminal pairing QR printed: %s', printed)
      return jsonResponse(200, { ok: true })
    }),

    pairConfirm: guard(async (request) => {
      const body = await readActionBody(request)
      if (!body.ok) return body.response
      const sas = body.fields['sas']
      if (sas === undefined || !SAS_PATTERN.test(sas)) {
        return jsonResponse(400, { error: 'invalid-sas' })
      }
      const attempt = deps.pairingService.getActiveAttempt()
      if (attempt === null || attempt.state !== 'awaiting_confirmation') {
        return jsonResponse(409, { error: 'no-active-pairing' })
      }
      const confirmed = await deps.pairingService.confirmPairing(sas)
      return confirmed ? jsonResponse(200, { ok: true }) : jsonResponse(400, { error: 'sas-mismatch' })
    }),

    pairReject: guard(async (request) => {
      const body = await readActionBody(request)
      if (!body.ok) return body.response
      if (!deps.pairingService.hasActiveAttempt()) {
        return jsonResponse(200, { ok: true, rejected: false })
      }
      await deps.pairingService.rejectPairing('rejected')
      return jsonResponse(200, { ok: true, rejected: true })
    }),

    deviceRevoke: guard(async (request) => {
      const body = await readActionBody(request)
      if (!body.ok) return body.response
      const deviceId = body.fields['deviceId']
      if (deviceId === undefined || !DEVICE_ID_PATTERN.test(deviceId)) {
        return jsonResponse(400, { error: 'invalid-device-id' })
      }
      const device = deps.registry.getDeviceById(deviceId)
      if (device === null) return jsonResponse(404, { error: 'unknown-device' })
      if (device.revoked) return jsonResponse(409, { error: 'already-revoked' })
      // Local revoke first: dropping the device's channels is the security-critical half.
      deps.registry.revokeDevice(deviceId)
      if (deps.revokeEndpointOnRelay !== undefined) {
        try {
          await deps.revokeEndpointOnRelay(deviceId)
        } catch {
          ctx.logger.warn('remora: relay revoke failed for %s', deviceId.slice(0, 6))
          return jsonResponse(502, { error: 'relay-revoke-failed' })
        }
      }
      return jsonResponse(200, { ok: true })
    }),
  }
}

/**
 * Refuses a request another origin initiated. Connection's own fence already
 * runs upstream; this repeats the check against the `Host` header because the
 * bridge rewrites `request.url` to an internal origin, so the two headers are
 * the only trustworthy same-origin evidence.
 * @param request - the Fetch request as the bridge built it.
 * @returns a 403 response when the request is cross-origin, otherwise undefined.
 */
function denyCrossOrigin(request: Request): Response | undefined {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    return jsonResponse(403, { error: 'cross-origin' })
  }
  const origin = request.headers.get('origin')
  if (origin === null) return undefined
  // The opaque origin (`null` from sandboxed frames and file: pages) is never ours.
  if (origin === 'null') return jsonResponse(403, { error: 'cross-origin' })
  const host = request.headers.get('host')
  if (host === null) return jsonResponse(403, { error: 'cross-origin' })
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
      ? undefined
      : jsonResponse(403, { error: 'cross-origin' })
  } catch {
    return jsonResponse(403, { error: 'cross-origin' })
  }
}

/**
 * Whether the client asked for the page rather than data: a browser
 * navigation lists `text/html`, while API callers send a media type of their
 * own or nothing at all.
 * @param request - the Fetch request.
 * @returns true when `Accept` lists an acceptable `text/html`.
 */
function prefersHtml(request: Request): boolean {
  const accept = request.headers.get('accept')
  if (accept === null) return false
  return accept.split(',').some((entry) => {
    const [media, ...params] = entry.split(';')
    if (media?.trim().toLowerCase() !== 'text/html') return false
    const quality = params.map((param) => param.trim().toLowerCase()).find((param) => param.startsWith('q='))
    return quality === undefined || Number(quality.slice(2)) !== 0
  })
}

/**
 * Reads and bounds one action body: JSON when the media type or the first
 * byte says so, otherwise form-encoded, with an 8 KiB cap.
 * @param request - the Fetch request.
 * @returns the parsed fields, or the response refusing the body.
 */
async function readActionBody(request: Request): Promise<ActionBody> {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await request.arrayBuffer())
  } catch {
    return { ok: false, response: jsonResponse(400, { error: 'unreadable-body' }) }
  }
  if (bytes.byteLength > MAX_ACTION_BODY_BYTES) {
    return { ok: false, response: jsonResponse(413, { error: 'body-too-large' }) }
  }
  if (bytes.byteLength === 0) return { ok: true, fields: {} }

  const text = new TextDecoder().decode(bytes)
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType === 'application/json' || text.trimStart().startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, response: jsonResponse(400, { error: 'invalid-json' }) }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: jsonResponse(400, { error: 'invalid-json' }) }
    }
    // Non-string values are dropped: a missing field fails validation below.
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') fields[key] = value
    }
    return { ok: true, fields }
  }
  const fields: Record<string, string> = {}
  for (const [key, value] of new URLSearchParams(text)) fields[key] = value
  return { ok: true, fields }
}

/** Count of non-revoked devices; zero is what makes the terminal QR print. */
function countPairedDevices(registry: DeviceRegistry): number {
  return registry.listDevices().filter((device) => !device.revoked).length
}

/** Builds one JSON response with no-store caching. */
function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}
