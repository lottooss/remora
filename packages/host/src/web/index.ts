import QRCode from 'qrcode'
import type { DeviceRegistry } from '../devices/index.ts'
import type { HostIdentity } from '../identity/index.ts'
import type { PairingService } from '../pairing/index.ts'
import type { HostRelayConnection } from '../relay/index.ts'

export interface ManagementContext {
  pairingService: PairingService
  registry: DeviceRegistry
  relayConnection: HostRelayConnection
  identity: HostIdentity
  hostName: string
}

export function printTerminalQr(qrText: string): void {
  if (process.stdout.isTTY) {
    QRCode.toString(qrText, { type: 'terminal', small: true }, (err, str) => {
      if (!err && str) {
        process.stdout.write('\nScan this QR code with Remora on Android:\n\n')
        process.stdout.write(str)
        process.stdout.write('\n\n')
      }
    })
  }
}

export async function generateQrSvg(qrText: string): Promise<string> {
  return await QRCode.toString(qrText, { type: 'svg', margin: 2 })
}

export function renderDashboardHtml(
  data: {
    hostId: string
    hostName: string
    relayStatus: string
    devices: Array<{ deviceId: string; name: string; pairedAt: number; revoked: boolean }>
    activePairing: { sasCode?: string; expiresAt: number; state: string } | null
    qrSvg?: string
  },
): string {
  const devicesList =
    data.devices.length === 0
      ? '<p class="empty">No devices paired yet.</p>'
      : `<ul>${data.devices
          .map(
            (d) =>
              `<li class="${d.revoked ? 'revoked' : 'active'}">
                <div class="device-info">
                  <strong>${escapeHtml(d.name)}</strong>
                  <span class="id">${escapeHtml(d.deviceId)}</span>
                </div>
                ${
                  d.revoked
                    ? '<span class="badge revoked">Revoked</span>'
                    : `<button onclick="revokeDevice('${escapeHtml(d.deviceId)}')">Revoke</button>`
                }
              </li>`,
          )
          .join('')}</ul>`

  const pairingSection = data.activePairing
    ? data.activePairing.state === 'awaiting_confirmation'
      ? `<div class="card pairing-card">
           <h3>Confirm Pairing SAS Code</h3>
           <p>Enter the 6-digit code shown on your phone:</p>
           <div class="sas-display">${escapeHtml(formatSas(data.activePairing.sasCode ?? ''))}</div>
           <div class="actions">
             <button class="primary" onclick="confirmPairing('${escapeHtml(data.activePairing.sasCode ?? '')}')">Confirm</button>
             <button class="danger" onclick="rejectPairing()">Reject</button>
           </div>
         </div>`
      : `<div class="card pairing-card">
           <h3>Scan to Pair Device</h3>
           <div class="qr-container">${data.qrSvg ?? ''}</div>
           <p class="hint">Open Remora on your phone and scan this QR code.</p>
           <button class="danger" onclick="rejectPairing()">Cancel</button>
         </div>`
    : `<button class="primary" onclick="startPairing()">Pair New Device</button>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Remora Management</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { color: #58a6ff; font-size: 24px; margin-bottom: 8px; }
    .status-bar { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 20px; font-size: 14px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin-bottom: 20px; }
    ul { list-style: none; padding: 0; margin: 0; }
    li { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #21262d; }
    li:last-child { border-bottom: none; }
    .device-info strong { display: block; font-size: 15px; }
    .device-info .id { font-size: 12px; color: #8b949e; font-family: monospace; }
    button { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
    button:hover { background: #30363d; }
    button.primary { background: #238636; border-color: #2ea043; color: #fff; }
    button.primary:hover { background: #2ea043; }
    button.danger { background: #da3633; border-color: #f85149; color: #fff; }
    button.danger:hover { background: #f85149; }
    .badge.revoked { color: #f85149; font-size: 12px; }
    .qr-container svg { width: 220px; height: 220px; display: block; margin: 12px auto; background: white; border-radius: 4px; padding: 8px; }
    .sas-display { font-size: 32px; font-weight: bold; letter-spacing: 4px; text-align: center; color: #58a6ff; margin: 16px 0; }
    .actions { display: flex; gap: 8px; justify-content: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Remora Host Management</h1>
    <div class="status-bar">
      <div>Host: <strong>${escapeHtml(data.hostName)}</strong> (${escapeHtml(data.hostId.slice(0, 10))}...)</div>
      <div>Relay Status: <strong>${escapeHtml(data.relayStatus)}</strong></div>
    </div>
    <div class="card">
      <h2>Paired Devices</h2>
      ${devicesList}
    </div>
    <div class="card">
      <h2>Device Pairing</h2>
      ${pairingSection}
    </div>
  </div>
  <script>
    async function startPairing() {
      await fetch('/api/remora/pair/start', { method: 'POST' });
      location.reload();
    }
    async function confirmPairing(sas) {
      await fetch('/api/remora/pair/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sas })
      });
      location.reload();
    }
    async function rejectPairing() {
      await fetch('/api/remora/pair/reject', { method: 'POST' });
      location.reload();
    }
    async function revokeDevice(deviceId) {
      if (confirm('Revoke device ' + deviceId + '?')) {
        await fetch('/api/remora/devices/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId })
        });
        location.reload();
      }
    }
  </script>
</body>
</html>`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function formatSas(sas: string): string {
  if (sas.length === 6) {
    return `${sas.slice(0, 3)} ${sas.slice(3)}`
  }
  return sas
}
