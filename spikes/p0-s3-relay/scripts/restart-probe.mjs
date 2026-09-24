#!/usr/bin/env node
// P0-S3 restart probe: open one WebSocket, then wait to observe the close
// event when the wrangler dev process is killed underneath it.
const base = (process.argv[2] ?? 'http://127.0.0.1:8790').replace(/\/$/, '')
const u = new URL('/v1/connect', base)
u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
// The spike server requires valid id/kind query params to accept the upgrade.
u.searchParams.set('id', 'h_probe0001')
u.searchParams.set('kind', 'host')
u.searchParams.set('name', 'restart-probe')
const ws = new WebSocket(u.href)
ws.binaryType = 'arraybuffer'
ws.addEventListener('open', () => console.log(`OPEN ${new Date().toISOString()}`))
ws.addEventListener('message', (e) => {
  const t = typeof e.data === 'string' ? e.data : `<binary ${e.data.byteLength}B>`
  console.log(`MESSAGE ${t.slice(0, 120)}`)
})
ws.addEventListener('error', (e) => console.log(`ERROR ${e.error?.message ?? e.type}`))
ws.addEventListener('close', (e) => {
  console.log(`CLOSE code=${e.code} reason=${JSON.stringify(e.reason)} wasClean=${e.wasClean}`)
  process.exit(0)
})
setTimeout(() => {
  console.log('TIMEOUT: no close within 30s')
  process.exit(1)
}, 30_000)
