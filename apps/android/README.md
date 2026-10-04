# Remora for Android

Native Kotlin/Jetpack Compose client. Architecture: [blueprint §10](../../docs/blueprint.md#10-remora-for-android-appsandroid); decisions: [ADR-0005](../../docs/adr/0005-native-android-client.md).

| Module | Kind | Owner role | Filled by |
|---|---|---|---|
| `:app` | application | android | P1-K2, P2-K1, P5-K1 |
| `:core:model`, `:core:protocol`, `:core:crypto` | pure JVM | protocol-crypto | P1-K1 |
| `:core:transport` | pure JVM | android | P2-K1 |
| `:core:security`, `:core:data`, `:core:ui` | Android library | android | P1-K2, P2-K1, P2-K2, P3-K1 |
| `:feature:*` | Android library (Compose) | android | P2–P5 |

## Toolchain (P1-K2, stable as of 2026-09-24)

AGP 9.4.1 (built-in Kotlin — the `kotlin-android` plugin is intentionally not applied), Kotlin 2.4.20 (pure-JVM modules + Compose/serialization compiler plugins), KSP 2.3.12, Hilt 2.60.1, Compose BOM 2026.09.00, Navigation 2.10.1, Room 3.0.3, OkHttp 5.5.0, kotlinx.serialization 1.11.0, coroutines 1.11.0, Biometric 1.1.0, CameraX 1.6.2, ML Kit barcode 17.3.0, Tink 1.23.0, Firebase BOM 34.19.0 / google-services 4.5.0, Gradle 9.6.0 (wrapper), JDK 21.

SDK levels: `minSdk` 28, `compileSdk`/`targetSdk` 37 (Android 17).

### SDK packages the owner must have installed

The agent does not accept SDK licenses. With the licenses already accepted on the machine, these were installed via `sdkmanager` for P1-K2; on a fresh machine/CI install them yourself (or open the SDK Manager):

```sh
sdkmanager "platforms;android-37.0" "build-tools;36.0.0" "build-tools;37.0.0"
```

AGP 9.4.1 requires `build-tools;36.0.0`; it auto-installs missing packages only when licenses are already accepted, so install them yourself on a fresh machine.

Build with JDK 21 (set `sdk.dir` in the git-ignored `local.properties`, or `ANDROID_HOME`):

```sh
./gradlew assembleDebug testDebugUnitTest      # gradlew.bat on Windows cmd
./gradlew checkModuleDependencyRules           # blueprint §10.2 module rules
```

`testDebugUnitTest` also runs the pure-JVM modules' tests, including the ones that read the shared vectors in `../../conformance`. Firebase arrives with P5-K1: the google-services plugin and `firebase-messaging` are applied only when `app/google-services.json` exists (never committed).

## Module dependency rules (blueprint §10.2)

- **Gradle check:** `./gradlew checkModuleDependencyRules` fails when a `:feature:*` module declares a dependency outside `:core:ui`, `:core:data`, `:core:model`, or pulls in OkHttp, Room (`androidx.room`/`androidx.room3`) or Tink. It also runs as part of each feature module's `check`.
- **Source-review rule (not expressible in Gradle):** `android.security.keystore` / `KeyGenParameterSpec` APIs may appear only under `core/security/**`; features and other cores go through `:core:security`. Reviewers reject Keystore imports elsewhere.

## Application composition (P7)

- `RemoraViewModel` owns one runtime per paired host. Each runtime has its own connection,
  session/interaction/workspace repositories and services. Conversation, files and notification
  routes carry the host id explicitly; mutations validate the current selection again before dispatch.
- `RemoraNavHost` supplies real services and callbacks to pairing, hosts, sessions, conversation,
  new-session, files, approvals, settings and diagnostics screens. Models and remote-start policy
  come from the authenticated host instead of a sample catalog.
- Foreground connections survive a 30-second activity transition grace period. Backgrounding
  beyond that disconnects them; foregrounding restores global and visible-session streams.
  Pairing and push registration reserve the relay identity to avoid replacing the pairing socket.
- Material 3 theme in `:core:ui` (`Theme.kt`, `Color.kt`, `Type.kt`) — dark mode + dynamic color (Android 12+), plus `StatusDot` status components.
- `AppLockGate` requires the real system authentication prompt on cold start and after five minutes
  in the background. High-risk approvals use a biometric-bound signing operation and revalidate
  the displayed text/JSON digest and pending request after authentication.
- Approval-key rotation preserves the active key while the PC confirms the candidate. The user
  then explicitly acknowledges PC confirmation in Settings before activating the phone's candidate.
  RCP currently provides no automatic confirmation event; premature activation fails signature
  verification on the host and is not reported as proof of PC acceptance.
- Backup is off: `android:allowBackup="false"` plus `dataExtractionRules`/`fullBackupContent` excluding all data.

The implementation pass is distinct from release evidence. Android tests, installed-app checks,
Firebase delivery, physical biometrics and the frozen-spec reconciliation remain tracked in the
P7 handoffs. No Firebase configuration, signing key or deployment credential is committed.
