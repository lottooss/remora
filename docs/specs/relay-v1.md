# RLY/1 — Relay protocol

Status: **v1-draft** (frozen by P0-A1). Implementations: `apps/relay` (server), `@remora/relay-link` (TypeScript client for host and testkit), `:core:transport` (Kotlin client).
The relay is **content-blind**: it authenticates endpoints, routes opaque frames between linked endpoints, reports presence, and dispatches push notifications. It never parses SC/1 or RCP.

## 1. Deployment model

- Single tenant: one Worker (`remora-relay`) and one Durable Object instance `AccountHub` (`idFromName("account")`) per owner.
- Endpoints are **hosts** (`h_…`) and **devices** (`d_…`), identified per [Crypto/1 §2](crypto-v1.md#2-endpoint-identities).
- A **link** (host, device) is created when a device enrolls with a ticket issued by that host. Data frames flow only across links.

## 2. HTTP routes

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /v1/connect` (WebSocket upgrade) | in-band challenge (§3) | the only data path |
| `POST /v1/enroll/host` | `Authorization: Bearer <REMORA_ENROLL_SECRET>` | register a host key (§4.1) |
| `POST /v1/enroll/device` | enrollment ticket in body | register a device key and link it (§4.2) |
| `GET /v1/health` | none | `200 {"ok":true,"v":1}` |

Every other route returns `404`. Responses carry `cache-control: no-store`. Request bodies are JSON ≤ 4 KiB. CORS is not enabled (native clients only).

## 3. Connection and authentication

1. Client opens `wss://<relay>/v1/connect` (subprotocol `remora.rly.v1`; a server that does not echo it MUST be rejected by the client).
2. Relay sends `{"t":"challenge","v":1,"nonce":"<b64u 32 B>","time":<ms>}`.
3. Client sends `{"t":"auth","v":1,"kind":"host"|"device","id":"h_…","sig":"<b64u>","app":{"name":"remora-host","version":"0.1.0"}}` where `sig` signs the message in [Crypto/1 §4](crypto-v1.md#4-relay-authentication).
4. Relay verifies (key exists, not revoked, id derivation, signature) and replies `{"t":"ready","v":1,"id":"…","peers":[Peer…],"limits":{…}}`.

`Peer = { "id": "d_…", "kind": "device", "name": "Pixel 8", "online": true, "lastSeenAt": 1790000000000 }`.

A connection that has not authenticated within 10 s is closed with `4408`. If the same endpoint connects again, the older socket is closed with `4409` (newest wins).

Keepalive: clients send the text frame `{"t":"ping"}` every 25 s; the relay's WebSocket auto-response answers `{"t":"pong"}` without waking the Durable Object. Protocol-level pings are also answered by the runtime. A client that sees no pong for 60 s reconnects.

## 4. Enrollment

### 4.1 Host enrollment

`POST /v1/enroll/host` with the bearer secret and `{"v":1,"relayPub":"<b64u Ed25519>","name":"DESKTOP-OLSI","platform":"win32"}` → `200 {"v":1,"id":"h_…"}`. Re-enrolling the same key is idempotent. Rate limit: 10 per hour per client IP. `401` for a bad secret (constant-time compare).

### 4.2 Device enrollment

`POST /v1/enroll/device` with `{"v":1,"ticket":"<b64u>","relayPub":"<b64u>","name":"Pixel 8","platform":"android"}` → `200 {"v":1,"id":"d_…","hostId":"h_…"}` and the link (hostId, deviceId) is created. Errors: `400 bad_request`, `410 ticket_invalid` (unknown, expired, or used — indistinguishable on purpose), `429 rate_limited`. Rate limit: 20 per hour per IP.

### 4.3 Tickets

A host requests a ticket over its authenticated socket: `{"t":"enroll.ticket","rid":"r1"}` → `{"t":"enroll.ticket.ok","rid":"r1","ticket":"<b64u 32 B>","expiresAt":<ms>}`. The relay stores only `SHA-256(ticket)`, the host id, the expiry (10 min), and marks it used atomically on enrollment.

## 5. Control frames (text, JSON)

All control frames are JSON objects with a `t` type; requests carry a client-chosen `rid` (≤ 32 chars) echoed in the reply.

| `t` | Direction | Fields | Reply |
|---|---|---|---|
| `challenge` | R→C | `v, nonce, time` | — |
| `auth` | C→R | `v, kind, id, sig, app` | `ready` or `error` + close |
| `ready` | R→C | `v, id, peers[], limits` | — |
| `ping` / `pong` | C→R / R→C | — | auto-response |
| `presence` | R→C | `id, kind, online, at` | — |
| `enroll.ticket` | host→R | `rid` | `enroll.ticket.ok{rid,ticket,expiresAt}` |
| `endpoint.list` | host→R | `rid` | `endpoint.list.ok{rid, devices: Peer[]}` |
| `endpoint.revoke` | C→R | `rid, id` (host: a linked device; device: itself) | `ok{rid}` |
| `push` | host→R | `rid, to[], ct, collapse?, priority, ttl` | `push.result{rid, results:[{id,status}]}` |
| `push.token` | device→R | `rid, token, hostOffline` | `ok{rid}` |
| `bye` | C→R | `reason?` | relay closes with `1000` |
| `ok` | R→C | `rid` | — |
| `error` | R→C | `rid?, code, message, ref?` | — |

`push.status ∈ {sent, no_token, unregistered, error}`. `priority ∈ {high, normal}` maps to FCM `android.priority`. `ttl` seconds ≤ 86,400. `ct` ≤ 3,072 characters.

## 6. Data frames (binary)

```
offset  size  field
0       1     version            0x01
1       1     type               0x01 = DATA
2       2     reserved           0x0000
4       4     channel            u32 big-endian, chosen by the SC/1 initiator, non-zero
8       1     peer kind          0x01 host · 0x02 device
9       16    peer id            the 16 raw bytes behind the base32 part of the endpoint id
25      3     reserved           0x000000
28      …     payload            one SC/1 record (opaque to the relay)
```

- Sent by an endpoint, `peer` is the **destination**; delivered by the relay, `peer` is the **source**. The relay rewrites only these 17 bytes.
- Total frame size ≤ 65,536 bytes. Larger → `error{code:'too_large'}`, frame dropped.
- Destination not linked → `error{code:'not_linked'}`; offline → `error{code:'peer_offline'}`. The relay never buffers data for offline peers.
- Per-connection order is preserved. No other guarantees (a reconnect may lose frames in flight; SC/1 and RCP recover).

## 7. Presence

The relay sends `presence` to every linked peer when an endpoint authenticates or its last socket closes. `ready.peers` gives the initial state. `lastSeenAt` is written at most once per minute per endpoint.

## 8. Push

- On `push`, for each destination linked to the sending host: if the device has an FCM token and is not revoked, the relay sends an FCM HTTP v1 **data-only** message `{ "v": "1", "h": "<hostId>", "ct": "<ct>" }` with `collapse_key`, `android.priority`, and `android.ttl`.
- On `UNREGISTERED` / `INVALID_ARGUMENT` for a token, the relay clears it and reports `unregistered`.
- **Host offline alert:** when a host's last socket closes, the relay arms a Durable Object alarm for 120 s. If the host has not reconnected when it fires, each linked device with `hostOffline = true` receives `{ "v": "1", "h": "<hostId>", "k": "host_offline" }`. A reconnect cancels the alarm.
- FCM OAuth2 access tokens are minted from `FCM_SERVICE_ACCOUNT_JSON` (RS256 JWT via WebCrypto) and cached until 5 minutes before expiry.

## 9. Errors and close codes

| Close code | Meaning |
|---|---|
| 1000 | normal (`bye`) |
| 4400 | malformed frame or protocol violation |
| 4401 | authentication failed |
| 4403 | endpoint revoked or not allowed |
| 4408 | authentication timeout |
| 4409 | replaced by a newer connection of the same endpoint |
| 4426 | unsupported RLY version |
| 4429 | rate limit exceeded persistently |
| 4500 | internal error |

`error.code ∈ {bad_request, too_large, not_linked, peer_offline, rate_limited, forbidden, version, internal}`. Error messages never echo payload bytes.

## 10. Limits (defaults; Worker vars)

| Var | Default |
|---|---|
| `MAX_FRAME_BYTES` | 65536 |
| `RATE_FRAMES_PER_SEC` / `RATE_BURST` | 50 / 100 per connection (token bucket; excess → `error{rate_limited}`, persistent excess → close 4429) |
| `MAX_ENDPOINTS` | 32 |
| `TICKET_TTL_MS` | 600000 |
| `AUTH_TIMEOUT_MS` | 10000 |
| `HOST_OFFLINE_ALERT_MS` | 120000 |
| `LAST_SEEN_WRITE_INTERVAL_MS` | 60000 |

## 11. Versioning

The path carries the major version (`/v1/…`), frames carry `v` (control) or the version byte (data). Unknown control frame types are answered with `error{code:'bad_request'}` and otherwise ignored; unknown fields are ignored.

## 12. Conformance vectors

`conformance/vectors/relay/`: `data-frame.json` (encode/decode incl. boundary sizes), `control-frames.json` (valid and invalid examples per type), `auth.json` (shared with Crypto/1 §4).
