# Operations Runbook

> **v1 not released — see milestone P7.** An audit on 2026-09-28 found Remora does not yet work against real dsh or a real phone; several instructions below were corrected on 2026-09-30, and the dsh runtime/service sections were rewritten on 2026-10-05 (see [SWARM.md §0](../SWARM.md#0-why-this-phase-exists-read-this-it-is-not-optional)). Do not follow this guide end-to-end until the P7 wave-5 owner tasks (P7-O1…P7-O5) and the [§10 checklist](#10-release-checklist-owner) pass.

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
# 1. Install the pinned dsh into the dedicated Remora runtime — NOT a global install.
#    The service installed in §4 launches only this pinned copy (it verifies the exact
#    version and entry point), so your interactive dsh installation never becomes a
#    service dependency. Keep this window in this directory for step 4/5.
mkdir "%LOCALAPPDATA%\Remora\runtime"
cd /d "%LOCALAPPDATA%\Remora\runtime"
npm install @deepseek-ai/dsh@0.1.5-rc.3

# Shortcut used below (cmd):
set "DSH=%LOCALAPPDATA%\Remora\runtime\node_modules\@deepseek-ai\dsh\lib\bin.js"

# 2. Build host plugin and CLI (from the repository root)
pnpm run build

# 3. Pack the host plugin tarball (self-contained: the build bundles the
#    unpublished @remora/* packages; the tarball lands in the repo root)
pnpm -F @remora/host pack

# 4. Create dedicated remora profile from web default
node "%DSH%" --profile remora --from-default-profile web

# 5. Install the packed Remora host plugin into the profile
node "%DSH%" plugin --profile remora add ./remora-host-1.0.0.tgz
```

Installing from the packed tarball is the documented path (dsh-integration.md Q10): it
keeps the dsh peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/schemastery`)
singletons provided by dsh itself and needs no access to the Remora workspace afterwards.
Installing the checkout directory directly (`dsh plugin --profile remora add ./packages/host`)
is only for fast local iteration on a development machine.

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
node "%DSH%" --profile remora --no-open --port 7717
```
Open the printed `dsh web:` URL in your PC browser to establish the management session cookie. The service itself starts dsh with all output discarded (see §4), so this interactive run is how you obtain the GUI URL.

---

## 4. Install the Background Host Service (Always-On Supervision, Windows)

The `remora` CLI registers a per-user logon task (no elevation). It snapshots the
compiled CLI into `%LOCALAPPDATA%\Remora\services\<task>\cli`, so the service never
depends on this repository checkout, and it launches only the pinned dsh runtime from
§3 step 1.

```sh
# Build the CLI once (from the repository root; already done in §3 step 2)
pnpm run build

# Register the logon service (default task name RemoraHost; --task-name customises it)
node apps/cli/lib/bin.js service install --port 7717 --profile remora

# Lifecycle — every command reports the outcome it actually observed
node apps/cli/lib/bin.js service start      # start the registered task now
node apps/cli/lib/bin.js service status     # registration + supervisor liveness
node apps/cli/lib/bin.js service logs -f    # metadata-only lifecycle log (see below)
node apps/cli/lib/bin.js service stop       # ask the supervisor to stop its dsh child
node apps/cli/lib/bin.js service uninstall  # remove autostart, stop the supervisor

# Diagnostics and version
node apps/cli/lib/bin.js doctor --profile remora --relay-url https://remora-relay.<your-subdomain>.workers.dev
node apps/cli/lib/bin.js --version
```

Notes:

- **Logs are metadata-only.** The supervisor records fixed lifecycle facts (started,
  exited, restart delay), capped at 1 MiB per day, under
  `%LOCALAPPDATA%\Remora\logs\<task>\remora-YYYY-MM-DD.log`. dsh output is never
  captured because it can contain conversation content and the browser credential
  (AGENTS.md §1.8); use dsh's own GUI for anything beyond lifecycle state.
- **Custom task names.** `--task-name RemoraLaptop` scopes the scheduled task, the
  service state directory and the log directory, so several configurations coexist.
- **No elevation, no shell.** Registration creates the task with
  `Register-ScheduledTask` for your own user (RunLevel Limited) and executes
  `conhost.exe --headless <node> <bin.js> host run --installed-task <task>` directly
  (no `cmd.exe`). If Task Scheduler denies it, an `HKCU\...\Run` entry is the
  documented fallback; `service uninstall` removes whichever exists and says so.
- **Acknowledged lifecycle.** `start`, `stop` and `uninstall` poll the real supervisor
  state and report success only when they observed it. Stop is requested through a
  `stop-request` file watched by the supervisor; nothing is killed from a stored PID.
- **Locking.** A per-task `supervisor.json` (exclusive create + liveness check)
  prevents two service instances for the same task name; install is refused while a
  supervisor is running.
- **Uninstall retains data.** The runtime, CLI snapshot, logs and the dsh profile are
  kept; only the autostart registration and the running supervisor are removed.

> **Power settings:** Automatic keep-awake during active agent turns is implemented in
> the host (P7-H6, Windows keep-awake). Confirm active acquisition on your machine —
> OWNER-PENDING evidence. Laptop lid-close and battery policies still apply; set
> *Sleep when plugged in* to *Never* for 24/7 availability.

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

The host persists its identity in the dsh credentials record `remora/host-identity`
(P7-H2) and paired devices in the persistent device registry (P7-H4); both live inside
the dedicated dsh profile area. Back up the whole profile directory
(`%USERPROFILE%\.dsh\profiles\remora`) plus the dsh credentials store. That backup
contains secret key material: store it encrypted, and never in logs, snapshots or this
repository.

---

## 9. Troubleshooting Matrix

| Symptom | Probable Cause | Resolution |
|---|---|---|
| Phone shows "Host Offline" | dsh host process stopped or relay unreachable | Run `remora service status` and `remora doctor --profile remora`. Verify `relayUrl` in `cordis.patch.yml`. |
| Pairing QR fails to generate | Invalid relay enrollment secret | Check host logs (`remora service logs`). Verify that `REMORA_RELAY_ENROLL_SECRET` matches the Cloudflare secret. |
| No push notifications received | Missing `google-services.json` or FCM key | Verify `google-services.json` was present when building Android app. Verify `FCM_SERVICE_ACCOUNT_JSON` secret in Cloudflare. Ensure Android notification permissions are granted. |
| Biometric prompt requested on every action | High-risk approval policy active | Expected behavior for destructive commands (e.g. `rm`, file deletion, shell pipelines) per Blueprint §11 security model. |
| Path access denied error | Requested path outside configured roots | Add workspace directories to `remoteRoots` in `%USERPROFILE%\.dsh\profiles\remora\cordis.patch.yml`. |
| `service install` says the pinned runtime is missing | Dedicated runtime absent or wrong version | Repeat §3 step 1 (`npm install @deepseek-ai/dsh@0.1.5-rc.3` inside `%LOCALAPPDATA%\Remora\runtime`). A global `dsh` on PATH does not count. |
| `service start` says the supervisor did not report startup | Snapshot CLI, runtime or profile problem | Run `remora doctor --profile remora`, read `%LOCALAPPDATA%\Remora\logs\<task>\`, then retry. If an orphaned dsh from a hard crash still holds the port, close it before retrying (the supervisor never kills stored PIDs). |

---

## 10. Release checklist (owner)

Everything below needs owner accounts, secrets, devices or signing keys — agents leave
these boxes unticked (`OWNER-PENDING`, docs/SWARM.md §1 rule 5).

- [ ] OWNER-PENDING: Relay deployed and `REMORA_ENROLL_SECRET` stored in Cloudflare (§1); record the worker URL here.
- [ ] OWNER-PENDING: Firebase project created, `apps/android/app/google-services.json` placed, `FCM_SERVICE_ACCOUNT_JSON` uploaded (§2).
- [ ] OWNER-PENDING: Dedicated pinned dsh runtime installed (`%LOCALAPPDATA%\Remora\runtime`, §3 step 1).
- [ ] OWNER-PENDING: `remora` profile created, packed host plugin installed, `cordis.patch.yml` configured (relay URL, `remoteRoots`, notification preferences, §3).
- [ ] OWNER-PENDING: Enrollment secret provided to dsh as `REMORA_RELAY_ENROLL_SECRET` (§3).
- [ ] OWNER-PENDING: Interactive dsh run verified; management URL opened once (§3).
- [ ] OWNER-PENDING: Service installed and started; survives sign-out/sign-in and a dsh kill on the real PC (§4). Automated CI proof of this is task P7-T2 and is not yet implemented.
- [ ] OWNER-PENDING: Android release keystore generated, release APK signed and installed (§5).
- [ ] OWNER-PENDING: Physical phone paired with SAS confirmation; approval, question, session and file flows exercised ([device-test.md](device-test.md) filled in by the owner, §6).
- [ ] OWNER-PENDING: Device revocation verified from the management dashboard (§7).
- [ ] OWNER-PENDING: Encrypted backup of the dsh profile taken (§8).
- [ ] OWNER-PENDING: GitHub required checks configured and `v1.0.0` tag created only after every box above has evidence.
