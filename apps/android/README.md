# Remora for Android

Native Kotlin/Jetpack Compose client. Architecture: [blueprint §10](../../docs/blueprint.md#10-remora-for-android-appsandroid); decisions: [ADR-0005](../../docs/adr/0005-native-android-client.md).

| Module | Kind | Owner role | Filled by |
|---|---|---|---|
| `:app` | application | android | P1-K2, P2-K1, P5-K1 |
| `:core:model`, `:core:protocol`, `:core:crypto` | pure JVM | protocol-crypto | P1-K1 |
| `:core:transport` | pure JVM | android | P2-K1 |
| `:core:security`, `:core:data`, `:core:ui` | Android library | android | P1-K2, P2-K1, P2-K2, P3-K1 |
| `:feature:*` | Android library (Compose) | android | P2–P5 |

Build with JDK 21 and Android SDK platform 34 (set `sdk.dir` in the git-ignored `local.properties`, or `ANDROID_HOME`):

```sh
./gradlew assembleDebug testDebugUnitTest      # gradlew.bat on Windows cmd
```

`testDebugUnitTest` also runs the pure-JVM modules' tests, including the ones that read the shared vectors in `../../conformance`. The skeleton uses the toolchain cached on the development machine (AGP 8.6, Kotlin 2.0.20, compileSdk 34); P1-K2 upgrades it. Firebase arrives with P5-K1 and is applied only when `app/google-services.json` exists (never committed).
