# ADR-0002: Self-hosted content-blind relay on Cloudflare Workers + Durable Objects

- Status: Accepted
- Date: 2026-09-24
- Deciders: Owner, Integrator, Relay

## Context

`dsh web` is loopback-only by design (it rejects `--host 0.0.0.0` and authenticates with a launch-token cookie). The phone must reach the PC from any network without inbound ports, VPN apps, or exposing dsh publicly. The owner chose a self-hosted relay and Cloudflare's free tier.

## Decision

- One Worker (`remora-relay`) and one SQLite-backed Durable Object instance (`AccountHub`) per owner, using the WebSocket Hibernation API and `setWebSocketAutoResponse` for keepalives.
- Hosts and devices connect **outbound** over `wss://`, authenticate with Ed25519 challenge/response, and exchange opaque SC/1 records that the relay routes between linked endpoints without parsing ([RLY/1](../specs/relay-v1.md)).
- The relay also handles enrollment, presence, host-offline alarms, and FCM dispatch (ADR-0006).

## Consequences

- Cost: fits the free plan (100,000 DO requests/day, incoming WebSocket messages billed 20:1, outgoing messages and pings free, 13,000 GB-s/day) with streaming coalesced to ≤ 7 messages/s and streams opened only when a phone is watching.
- Deploying the Worker disconnects every WebSocket; both clients reconnect with jittered backoff and resume streams by cursor.
- Only SQLite-backed Durable Objects are available on the free plan.
- Vendor coupling is limited: RLY/1 is small enough to reimplement on Node if ever needed.

## Alternatives considered

- **Tailscale mesh:** no relay to build, but requires the VPN app on the phone; not chosen by the owner.
- **Cloudflare Tunnel exposing `dsh web`:** creates a public surface for a server designed for loopback, fights dsh's Host/Origin trust fence, and needs Cloudflare Access in front. Rejected.
- **Node relay on a VM:** full control but the owner maintains uptime, TLS, and patching. Rejected for v1.
- **Telegram bot bridge:** no app to build, but plaintext passes through a third party and the UI is limited. Rejected.
