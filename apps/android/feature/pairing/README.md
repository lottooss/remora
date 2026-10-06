# Pairing

The pairing screen scans QR codes with CameraX and bundled ML Kit, requests camera permission, and releases the analyzer, camera binding, scanner, and executor when it leaves composition. Manual URI input is compiled into debug builds only. Pairing input is limited to 4 KiB and validated by `core:data` for version, expiry, endpoint format, key lengths, and an HTTPS relay origin without credentials, query, fragment, or path.

`PairingService` requires a real biometric approval key, verifies the enrolled device and host identities, runs the existing pinned Noise pairing handshake, displays SAS, and persists key material and the host before acknowledging `pair.complete` with its received request ID. Every exit closes the channel/socket and clears owned secret arrays. UI errors are stable codes mapped to resources, never raw network or crypto exceptions.

Physical camera, biometric, background/restart, PC confirmation, and deployed relay checks remain owner-pending. The P7-A3 unit test source includes invalid version, expiry, and cleartext-origin cases; test execution is deferred at the owner's request.
