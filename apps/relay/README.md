# @remora/relay

Cloudflare Worker `remora-relay` + Durable Object `AccountHub` (SQLite, WebSocket hibernation): enrollment, authentication, routing, presence, limits, FCM push, host-offline alarm. Content-blind.

```sh
pnpm -F @remora/relay run dev          # wrangler dev on http://127.0.0.1:8787
pnpm -F @remora/relay test             # tests inside workerd
pnpm -F @remora/relay run deploy:check # bundle without deploying
pnpm -F @remora/relay run types        # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Deploying (`run deploy`) and secrets (`wrangler secret put`) are owner actions; see docs/runbooks/operations.md §1.

- **Specs:** docs/specs/relay-v1.md, docs/blueprint.md §9, docs/adr/0002-cloudflare-e2e-relay.md
- **Implemented by:** P0-S3 (spike), P1-R1, P5-R1
- **Owner role:** relay (AGENTS.md §3)

Status: skeleton. Read AGENTS.md before changing this package.
