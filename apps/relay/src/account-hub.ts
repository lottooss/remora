/**
 * `AccountHub`: the one Durable Object per owner (RLY/1 §1). Task P1-R1 adds
 * the SQLite schema (blueprint §9.2), WebSocket hibernation handlers,
 * authentication, enrollment, routing, presence, and limits; task P5-R1 adds
 * push dispatch and the host-offline alarm.
 */
import { DurableObject } from 'cloudflare:workers'

export class AccountHub extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url)
    return new Response(JSON.stringify({ error: 'not_implemented', task: 'P1-R1', path: pathname }), {
      status: 501,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
}
