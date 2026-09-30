# Operations Runbook

> **v1 not released — see milestone P7.** An audit on 2026-09-28 found Remora does not yet work against real dsh or a real phone; several instructions below were corrected on 2026-09-30 (see [SWARM.md §0](../SWARM.md#0-why-this-phase-exists-read-this-it-is-not-optional)). Do not follow this guide end-to-end until the P7 wave-5 owner tasks (P7-O1…P7-O5) pass.

Owner-facing guide from zero to "my phone controls dsh on my PC".

---

## 0. Prerequisites

- **PC:** Windows 11 where you use dsh, Node ≥ 24 (pinned in `.node-version`), pnpm, Git.
- **Phone:** Android 9+ (API 28+) device with screen lock and biometric unlock (fingerprint or face) configured.
- **Relay:** A free Cloudflare account with two-factor authentication (2FA) enabled.
- **Push:** A free Firebase project (Firebase Cloud Messaging).
- **Code:** This repository cloned to your PC (`git clone https://github.com/lottooss/remora.git`).

---

## 1. Deploy the Relay (Cloudflare Worker + Durable Object)

The relay is an end-to-end encrypted router. It inspects only 28-byte binary frame headers and never reads, stores, or logs plaintext conversation data.

```sh
pnpm install

# Authenticate with Cloudflare
pnpm -F @remora/relay exec wrangler login

# Generate a strong 32-byte enrollment secret and store it in Cloudflare Secret storage
pnpm -F @remora/relay exec wrangler secret put REMORA_ENROLL_SECRET
# When prompted, paste a random 32-byte base64url string, for example generated via:
# node -e "console.log(crypto.randomBytes(32).toString('base64url'))"

# Deploy to Cloudflare Workers
pnpm -F @remora/relay run deploy
```

Record the deployed worker URL:
`https://remora-relay.<your-subdomain>.workers.dev`

---

## 2. Configure Firebase Cloud Messaging (Push Notifications)

1. Open the [Firebase Console](https://console.firebase.google.com/) and create a project (e.g., `remora-push`).
2. Add an Android app with package name `io.github.lottooss.remora` (and `io.github.lottooss.remora.debug` if using debug builds).
3. Download the generated `google-services.json` and place it in `apps/android/app/google-services.json` (this file is git-ignored).
4. In Project Settings → **Service Accounts**, select **Firebase Cloud Messaging API Admin**, click **Generate new private key**, and download the JSON keyfile.
5. Upload the service account JSON to your Cloudflare Relay Worker:
```sh
pnpm -F @remora/relay exec wrangler secret put FCM_SERVICE_ACCOUNT_JSON
# Paste the entire contents of the downloaded service account JSON file
```

---

## 3. Install Remora Host into DeepSeek Harness (`dsh`)

The Remora Host runs as a Cordis plugin inside `dsh`, operating strictly within an isolated profile (`remora`).

```sh
# 1. Install pinned dsh version
npm install -g @deepseek-ai/dsh@0.1.5-rc.3

# 2. Build host plugin and CLI
pnpm run build

# 3. Create dedicated remora profile from web default
dsh --profile remora --from-default-profile web

# 4. Link Remora host plugin to profile
dsh plugin --profile remora add ./packages/host
```

Provide the enrollment secret to dsh as the key `REMORA_RELAY_ENROLL_SECRET` (its value is the `REMORA_ENROLL_SECRET` you stored in Cloudflare above). There is no dedicated dsh CLI command for this: dsh-credentials-local resolves credential keys from the launch environment, then its store, then the project `.env`, then the harness-home `.env`. The simplest option is to put `REMORA_RELAY_ENROLL_SECRET=<value>` in `%USERPROFILE%\.dsh\.env` (or export it in the process environment you launch dsh from):

```text
# %USERPROFILE%\.dsh\.env
REMORA_RELAY_ENROLL_SECRET=<your-enroll-secret>
```

Edit your profile configuration patch at `%USERPROFILE%\.dsh\profiles\remora\cordis.patch.yml`:

```yaml
- id: remora
  config:
    relayUrl: https://remora-relay.<your-subdomain>.workers.dev
    enrollSecretKey: REMORA_RELAY_ENROLL_SECRET
    remoteRoots:
      - 'C:\Users\<your-user>\Desktop\workspace'
    approvalBiometric: high
    approvalAuth: biometric
    approvalTimeoutMs: 3600000
    allowRemoteSessionStart: true
    keepAwake: while-busy
    streamCoalesceMs: 150
    notify:
      approval: true
      question: true
      turnDone: true
      turnError: true
      hostOffline: true
```

Run dsh once interactively to verify startup:
```sh
dsh --profile remora --no-open --port 7717
```
Open the printed `dsh web:` URL in your PC browser to establish the management session cookie.

---

## 4. Install Background Host Service (Always-On Supervision)

Use the Remora CLI to manage the Windows logon supervisor:

```sh
# Build CLI
pnpm -F @remora/cli run build

# Install Windows Task Scheduler logon service
node apps/cli/lib/bin.js service install --port 7717 --profile remora

# Check service health and live logs
node apps/cli/lib/bin.js service status
node apps/cli/lib/bin.js service logs -f

# Run comprehensive system diagnostics
node apps/cli/lib/bin.js doctor --profile remora
```

To stop or uninstall the service at any time:
```sh
node apps/cli/lib/bin.js service uninstall
```

> **Power settings recommendation:** Set *Sleep when plugged in* to *Never* in Windows Settings (System → Power). Automatic keep-awake during active agent turns is **not implemented yet** — the current keep-awake path is a no-op on Windows (see [SWARM.md §0](../SWARM.md#0-why-this-phase-exists-read-this-it-is-not-optional)); P7-H6 will fix it and this note will be updated when it lands. Until then, the manual power setting above is the only thing keeping the PC awake.

---

## 5. Build and Sign the Android App

### 5.1 Debug Build (Local Testing)
With USB debugging enabled on your phone:
```sh
cd apps/android
./gradlew.bat installDebug
```

### 5.2 Release Build (Signed APK)
1. Generate an Android release keystore (if you do not already have one):
```sh
keytool -genkey -v -keystore remora-release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias remora -storetype JKS
```
2. Set environment variables in your terminal session:
```powershell
$env:KEYSTORE_PATH = "C:\path\to\remora-release.jks"
$env:KEYSTORE_PASSWORD = "your-keystore-password"
$env:KEY_ALIAS = "remora"
$env:KEY_PASSWORD = "your-key-password"
```
3. Build the release APK:
```sh
cd apps/android
./gradlew.bat assembleRelease
```
The signed APK will be generated at:
`apps/android/app/build/outputs/apk/release/app-release.apk`

Transfer and install `app-release.apk` to your phone via ADB or file transfer.

---

## 6. Pairing Phone and PC

1. On your PC, navigate to `http://127.0.0.1:7717/api/remora/` in your browser.
2. Click **Pair phone** to display the one-time enrollment QR code.
3. Open the Remora app on your Android device and tap **Pair**.
4. Scan the QR code with your phone camera.
5. Verify that the 6-digit Short Authentication String (SAS) displayed on your phone matches the SAS displayed on your PC screen.
6. Click **Confirm** on the PC.
7. The phone is now authenticated and pins the host's identity key.

---

## 7. Device Management & Revocation

If a paired device is lost, stolen, or decommissioned:
1. Open the PC management dashboard at `http://127.0.0.1:7717/api/remora/`.
2. Under **Paired Devices**, locate the device name and click **Revoke**.
3. Revocation takes effect immediately:
   - The device static key is marked revoked in the host registry.
   - All active relay WebSockets and Noise channels for that device are terminated.
   - The device cannot reconnect or re-enroll without a newly generated pairing QR code.

---

## 8. Backup and Disaster Recovery

### 8.1 Relay State
The Cloudflare Worker Durable Object (`AccountHub`) stores all routing metadata and device mappings in Cloudflare's globally replicated Durable Object SQLite storage. No manual database backup is required. If redeploying the worker code, existing SQLite storage persists automatically.

### 8.2 Host Identity and Paired Devices

The host currently does **not** persist its identity keys or the paired-device registry — every restart forgets both (see [SWARM.md §0](../SWARM.md#0-why-this-phase-exists-read-this-it-is-not-optional)). Where this state will live is **determined by P7-H2 (persistent host identity) and P7-H4 (persistent device registry)**; until those tasks land there is nothing reliable to back up, and this section will be updated when they merge.

---

## 9. Troubleshooting Matrix

| Symptom | Probable Cause | Resolution |
|---|---|---|
| Phone shows "Host Offline" | dsh host process stopped or relay unreachable | Run `remora service status` and `remora doctor --profile remora`. Verify `relayUrl` in `cordis.patch.yml`. |
| Pairing QR fails to generate | Invalid relay enrollment secret | Check host logs (`remora service logs`). Verify that `REMORA_RELAY_ENROLL_SECRET` matches the Cloudflare secret. |
| No push notifications received | Missing `google-services.json` or FCM key | Verify `google-services.json` was present when building Android app. Verify `FCM_SERVICE_ACCOUNT_JSON` secret in Cloudflare. Ensure Android notification permissions are granted. |
| Biometric prompt requested on every action | High-risk approval policy active | Expected behavior for destructive commands (e.g. `rm`, file deletion, shell pipelines) per Blueprint §11 security model. |
| Path access denied error | Requested path outside configured roots | Add workspace directories to `remoteRoots` in `%USERPROFILE%\.dsh\profiles\remora\cordis.patch.yml`. |
