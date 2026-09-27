# Operations runbook

Owner-facing guide from zero to "my phone controls dsh on my PC". Sections become executable as their tasks land (noted per section); P6-O1 completes and verifies the whole guide.

## 0. What you need

- Windows 11 PC where you use dsh, Node ≥ 24, pnpm, Git.
- An Android phone (Android 9+) with a fingerprint or face unlock enrolled.
- A free Cloudflare account (enable 2FA).
- A free Firebase project (for push notifications).
- This repository cloned on the PC.

## 1. Deploy the relay (from P1-R1; push from P5-R1)

```sh
pnpm install
pnpm -F @remora/relay exec wrangler login            # opens a browser; you approve
pnpm -F @remora/relay exec wrangler secret put REMORA_ENROLL_SECRET     # paste 32+ random bytes, e.g. from: node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
pnpm -F @remora/relay run deploy
```

Note the printed `https://remora-relay.<your-subdomain>.workers.dev` URL. Keep the enroll secret; the PC needs it once.

## 2. Firebase for notifications (from P5-K1)

1. Create a Firebase project; add an Android app with package `io.github.lottooss.remora` (and `.debug` for debug builds).
2. Download `google-services.json` to `apps/android/app/` (git-ignored).
3. Create a service account with the *Firebase Cloud Messaging API Admin* role, download its JSON key, then:

```sh
pnpm -F @remora/relay exec wrangler secret put FCM_SERVICE_ACCOUNT_JSON   # paste the JSON
```

## 3. Install the host into dsh (from P1-H1; pairing from P2-H1)

```sh
npm install -g @deepseek-ai/dsh@0.1.5-rc.3          # or the version in upstream.lock.json
pnpm -F @remora/host run build
dsh --profile remora --from-default-profile web     # once
dsh plugin --profile remora add ./packages/host
```

Store the enroll secret in dsh credentials under the key `REMORA_RELAY_ENROLL_SECRET` (exact command documented by P1-H1), then add your settings to `%USERPROFILE%\.dsh\profiles\remora\cordis.patch.yml`:

```yaml
- id: remora
  config:
    relayUrl: https://remora-relay.<your-subdomain>.workers.dev
    enrollSecretKey: REMORA_RELAY_ENROLL_SECRET
    remoteRoots: ['C:\Users\<you>\Desktop\lotoss']
    approvalBiometric: high
    approvalAuth: biometric
    approvalTimeoutMs: 3600000
    allowRemoteSessionStart: true
    keepAwake: while-busy
    streamCoalesceMs: 150
    notify: { approval: true, question: true, turnDone: true, turnError: true, hostOffline: true }
```

Run it: `dsh --profile remora --no-open --port 7717` and open the printed `dsh web:` URL once in your PC browser.

## 4. Keep it running (from P5-O1)

```sh
pnpm -F @remora/cli run build
node apps/cli/lib/bin.js service install --port 7717 --profile remora
node apps/cli/lib/bin.js service status
node apps/cli/lib/bin.js service logs -f
node apps/cli/lib/bin.js doctor --profile remora
```

To uninstall or stop the logon background service:
```sh
node apps/cli/lib/bin.js service uninstall
```

For 24/7 availability set *Sleep when plugged in* to *Never* (Settings → System → Power) or accept that the phone will show the PC offline while it sleeps. Remora keeps the PC awake only while an agent is working.

## 5. Install the app and pair (from P2-K1)

1. Build and install: `cd apps/android && ./gradlew installDebug` (USB debugging on) or copy the APK.
2. On the PC open `http://127.0.0.1:7717/api/remora/` (after opening the `dsh web:` URL once) → **Pair phone**.
3. In the app: **Pair** → scan the QR → compare the 6 digits → click **Confirm** on the PC.

## 6. Revoke a device

PC: `http://127.0.0.1:7717/api/remora/` → Devices → Revoke. Takes effect immediately. The phone can also unpair itself in Settings.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Phone shows PC offline | `remora service status`; relay URL in the patch; `remora doctor` |
| Pairing QR never appears | host log for relay enrollment errors (wrong enroll secret) |
| No notifications | `google-services.json` present at build time; FCM secret set; Android notification permission |
| Approval asks for fingerprint every time | expected for high-risk approvals; see `approvalBiometric` |
