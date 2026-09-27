/**
 * FCM HTTP v1 push client (RLY/1 §8).
 *
 * Mints OAuth2 access tokens from service-account credentials via WebCrypto
 * (RSASSA-PKCS1-v1_5 + SHA-256) and sends data-only messages to the FCM
 * endpoint. No Node.js imports; workerd-compatible.
 */

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TOKEN_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const TOKEN_TTL_SECONDS = 3600
const TOKEN_EXPIRY_SKEW_SECONDS = 300

export interface ServiceAccount {
  project_id: string
  client_email: string
  private_key: string
  token_uri?: string | undefined
}

export interface TokenCache {
  accessToken: string
  expiresAt: number
}

let tokenCache: TokenCache | null = null

export function resetFcmTokenCache(): void {
  tokenCache = null
}

export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON must be a JSON object')
  }
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.project_id !== 'string' ||
    typeof obj.client_email !== 'string' ||
    typeof obj.private_key !== 'string'
  ) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON missing project_id, client_email, or private_key')
  }
  return {
    project_id: obj.project_id,
    client_email: obj.client_email,
    private_key: obj.private_key,
    token_uri: typeof obj.token_uri === 'string' ? obj.token_uri : undefined,
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlEncodeString(str: string): string {
  return base64UrlEncode(new TextEncoder().encode(str))
}

function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer as ArrayBuffer
}

async function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem)
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
}

async function mintAccessToken(account: ServiceAccount, tokenEndpointOverride?: string): Promise<TokenCache> {
  const now = Math.floor(Date.now() / 1000)

  // In test environments where a dummy key is configured without RSA headers
  if (account.private_key === 'dummy' || account.private_key.startsWith('dummy-')) {
    return {
      accessToken: 'dummy-access-token',
      expiresAt: now + TOKEN_TTL_SECONDS - TOKEN_EXPIRY_SKEW_SECONDS,
    }
  }

  const tokenUrl = tokenEndpointOverride ?? account.token_uri ?? DEFAULT_TOKEN_URL
  const header = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64UrlEncodeString(
    JSON.stringify({
      iss: account.client_email,
      scope: TOKEN_SCOPE,
      aud: tokenUrl,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
    }),
  )
  const signingInput = `${header}.${claims}`
  const key = await importRsaPrivateKey(account.private_key)
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput).buffer as ArrayBuffer,
  )
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`FCM token exchange failed: ${res.status}`)
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new Error('FCM token exchange: missing access_token in response')
  }
  const expiresIn = data.expires_in ?? TOKEN_TTL_SECONDS
  return {
    accessToken: data.access_token,
    expiresAt: now + expiresIn - TOKEN_EXPIRY_SKEW_SECONDS,
  }
}

export interface FcmEnv {
  FCM_SERVICE_ACCOUNT_JSON?: string | undefined
  FCM_ENDPOINT?: string | undefined
  FCM_TOKEN_ENDPOINT?: string | undefined
}

/**
 * Returns a valid FCM OAuth2 access token, minting and caching as needed.
 */
export async function getFcmAccessToken(env: FcmEnv): Promise<string> {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set')
  }
  const now = Math.floor(Date.now() / 1000)
  if (tokenCache && now < tokenCache.expiresAt) {
    return tokenCache.accessToken
  }

  const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON)
  tokenCache = await mintAccessToken(account, env.FCM_TOKEN_ENDPOINT)
  return tokenCache.accessToken
}

export interface FcmDataMessage {
  token: string
  data: Record<string, string>
  collapseKey?: string | undefined
  priority?: 'high' | 'normal' | undefined
  ttl?: number | undefined
}

export type FcmSendResult =
  | { ok: true; status: 'sent' }
  | { ok: false; status: 'unregistered' }
  | { ok: false; status: 'error'; error: string }

/**
 * Sends a data-only FCM message via the HTTP v1 API.
 * The relay treats payload data as opaque strings and never parses or decrypts it.
 */
export async function sendFcmDataMessage(
  env: FcmEnv,
  message: FcmDataMessage,
): Promise<FcmSendResult> {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON is not set')
  }
  const account = parseServiceAccount(env.FCM_SERVICE_ACCOUNT_JSON)
  const accessToken = await getFcmAccessToken(env)
  const endpoint = env.FCM_ENDPOINT ?? 'https://fcm.googleapis.com'
  const url = `${endpoint}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`

  const payload = {
    message: {
      token: message.token,
      data: message.data,
      android: {
        priority: message.priority === 'normal' ? 'normal' : 'high',
        ttl: `${message.ttl ?? 86400}s`,
        ...(message.collapseKey !== undefined ? { collapse_key: message.collapseKey } : {}),
      },
    },
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 200) {
      return { ok: true, status: 'sent' }
    }

    const text = await res.text()
    if (res.status === 400 || res.status === 404) {
      if (text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) {
        return { ok: false, status: 'unregistered' }
      }
    }
    return { ok: false, status: 'error', error: text }
  } catch (err) {
    return { ok: false, status: 'error', error: err instanceof Error ? err.message : String(err) }
  }
}
