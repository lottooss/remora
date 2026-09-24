/**
 * Remora relay Worker (RLY/1 §2). Routes the connect and enrollment paths to the
 * single `AccountHub` Durable Object and answers health checks; every other
 * path is 404. The Worker and the object never read data-frame payloads.
 * Object implementation: task P1-R1 (push: P5-R1).
 */
import { AccountHub } from './account-hub.ts'

export { AccountHub }

const HUB_PATHS: ReadonlySet<string> = new Set(['/v1/connect', '/v1/enroll/host', '/v1/enroll/device'])

/**
 * Build a JSON response that is never cached.
 * @param body - JSON-serializable response body.
 * @param status - HTTP status code.
 * @returns the response.
 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (pathname === '/v1/health' && request.method === 'GET') return json({ ok: true, v: 1 })
    if (HUB_PATHS.has(pathname)) {
      const hub = env.ACCOUNT_HUB.get(env.ACCOUNT_HUB.idFromName('account'))
      return hub.fetch(request)
    }
    return json({ error: 'not_found' }, 404)
  },
} satisfies ExportedHandler<Env>
