# ADR-0005: Native Android client (Kotlin, Compose, multi-module)

- Status: Accepted
- Date: 2026-09-24
- Deciders: Owner, Android, Integrator

## Context

The owner chose a native Android app and already built one with this stack (openRouterMobile: Compose, Hilt, Room, OkHttp, version catalogs, 10 modules). The app must store keys in hardware-backed storage, sign approvals behind biometrics, receive FCM pushes reliably, and render long streaming transcripts smoothly.

## Decision

- Kotlin + Jetpack Compose (Material 3), Hilt, Coroutines/Flow, kotlinx.serialization, OkHttp WebSockets, Room, DataStore, Tink, Android Keystore, AndroidX Biometric, CameraX + ML Kit barcode scanning, Firebase Messaging.
- Modules per [blueprint §10.2](../blueprint.md#102-modules). `:core:model`, `:core:protocol`, `:core:crypto`, `:core:transport` are pure JVM so they run fast unit tests and conformance vectors on any machine, and could later become Kotlin Multiplatform for an iOS client.
- minSdk 28 (Android 9: BiometricPrompt, Keystore improvements). The skeleton builds on the toolchain already cached on the development machine (AGP 8.6.0, Kotlin 2.0.20, compileSdk/targetSdk 34, Gradle 8.9, JDK 21); task P1-K1 modernizes the toolchain before feature work.
- Distribution: side-loaded debug/release APKs; no Play Store in v1.

## Consequences

- Best notification, background, and security integration on Android.
- Protocol and crypto are implemented twice (TypeScript and Kotlin); shared vectors in `conformance/` are the contract.
- Android only in v1.

## Alternatives considered

- **PWA:** shared TypeScript, but weaker push/background behavior and no Keystore-bound biometric signatures. Not chosen by the owner.
- **React Native / Expo:** cross-platform, but adds a JS runtime and bridges for Keystore and biometrics. Rejected.
- **Kotlin Multiplatform now:** premature; the pure-JVM core modules keep the door open.
