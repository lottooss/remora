# Android security

`SecureKeyStorage(context)` stores each host's key material under a Tink AES-GCM keyset, encrypted by `android-keystore://remora_master_v1`. The host ID is authenticated associated data. Writes complete before returning; unreadable records raise a sanitized error. Missing Keystore keys or an unencrypted keyset fail closed. Legacy data encrypted with the old process-only random key cannot be recovered and requires pairing again.

`AndroidBiometricAuthenticator(activity, approvalKeys)` implements app authentication and per-use P-256 signing through AndroidX `BiometricPrompt`. It requires a resumed `FragmentActivity`, serializes prompts, and cancels on backgrounding. Signing uses only the `Signature` returned in the successful `CryptoObject`; no signature or app unlock is produced on cancellation. Strong biometrics remain mandatory until a host-confirmed credential policy is represented in the connection policy.

`ApprovalKeyManager` reports the actual Keystore hardware status and creates StrongBox keys where available. A StrongBox-unavailable error may use standard Android Keystore with the same per-use authentication policy. Rotation creates a separately persisted pending alias; the previous key stays active until explicit activation after PC confirmation. Unpairing removes active and pending keys.

The storage persistence test lives in `src/androidTest` and exercises real Android Keystore/Tink across storage instances. Run `:core:security:connectedDebugAndroidTest` on an emulator or device. Unit tests cover lock refusal and background timing. Build, unit tests, instrumented tests, and physical biometric checks are deferred in the current implementation task at the owner's request.
