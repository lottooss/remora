# Remora v1 Spec Review & Ambiguities Register

> Task: **P0-A2**  
> Status: **Closed** — All 10 review items resolved and incorporated into the **v1-frozen** specifications and architecture.

---

## Ambiguity Register & Final Resolutions

### 1. JSON Field Order Irrelevance in Canonical Payload Hashing
- **Area:** [Crypto/1 §7](crypto-v1.md#7-approval-signatures), [RCP/1 §3](rcp-v1.md)
- **Status:** **CLOSED (Adopted in Crypto/1 v1-frozen)**
- **Resolution:** Canonical approval signing string uses lexicographically sorted keys at all object levels with no whitespace around separators (RFC 8785 JSON Canonicalization Scheme / JCS rules: `,` and `:` without extra spaces).
- **Owners:** `P1-C1` & `P0-A2`.

### 2. Character Offset Alignment in Streaming Text Updates
- **Area:** [RCP/1 §5](rcp-v1.md) (`SessionEvent: assistant.delta`, `files.read`)
- **Status:** **CLOSED (Adopted in RCP/1 v1-frozen)**
- **Resolution:** All string indices, line counts, and stream offsets in RCP/1 are Unicode code point counts for character indices and 1-indexed integers for file line numbers. Raw binary transfers (`files.readBytes`) use explicit byte offsets and byte lengths.
- **Owners:** `P1-P1`.

### 3. Initial Session Snapshot Size Packing Rule
- **Area:** [RCP/1 §5](rcp-v1.md) (`sessions.follow`, `sessions.get`)
- **Status:** **CLOSED (Adopted in RCP/1 v1-frozen)**
- **Resolution:** Initial inline snapshot delivered in the opening `follow` frame is capped at 50 messages or 48 KiB total frame size. Sessions exceeding this limit supply the most recent 50 messages with `hasMoreOlder: true` and the oldest sequence number; earlier messages are requested via `sessions.page`.
- **Owners:** `P1-H1` & `P2-H2`.

### 4. Timestamp Representation and Precision
- **Area:** [RCP/1 §3](rcp-v1.md), [RLY/1 §3](relay-v1.md), [Crypto/1 §4](crypto-v1.md)
- **Status:** **CLOSED (Adopted across specs v1-frozen)**
- **Resolution:** Wire timestamps across all RCP/1 JSON envelopes and payloads are standard ISO 8601 UTC strings with millisecond precision (`YYYY-MM-DDTHH:mm:ss.sssZ`). Ephemeral protocol tokens (e.g. relay auth challenge timestamp) use integer Unix epoch seconds.
- **Owners:** `P1-P1` & `P1-C1`.

### 5. Base64url Canonical Encoding and Padding
- **Area:** [Crypto/1 §2–§8](crypto-v1.md), [RLY/1 §3](relay-v1.md)
- **Status:** **CLOSED (Adopted in Crypto/1 & RLY/1 v1-frozen)**
- **Resolution:** All base64url representations in Remora wire formats (keys, signatures, hashes, tokens) MUST omit trailing `=` padding characters. Parsers must reject strings containing `=` padding as malformed (`fail closed`).
- **Owners:** `P1-C1` & `P1-K1`.

### 6. Out-of-tree Cordis Error Code Mapping
- **Area:** [RCP/1 §4](rcp-v1.md) (Error Model), [dsh integration](../upstream/dsh-integration.md)
- **Status:** **CLOSED (Adopted in Host Adapter architecture)**
- **Resolution:** The Remora DshAdapter strictly maps upstream slash-delimited error codes to RCP/1 snake_case error codes at the RPC boundary (`packages/host/src/adapter`). Unmapped errors map to `internal_error`.
- **Owners:** `P1-H1`.

### 7. Noise Transport Maximum Payload and Chunking
- **Area:** [Crypto/1 §6](crypto-v1.md#6-secure-channel-sc1), [RLY/1 §3](relay-v1.md)
- **Status:** **CLOSED (Adopted in Crypto/1 & RLY/1 v1-frozen)**
- **Resolution:** Maximum RCP plaintext message size is 48 KiB (49,152 bytes). Encrypted under Noise (adds 16-byte Poly1305 MAC) it fits within the 65,535-byte Noise packet limit, and with the 28-byte RLY/1 header, the entire relay frame remains well below the 64 KiB relay frame limit.
- **Owners:** `P0-A2` & `P1-C1`.

### 8. Biometric Signature S-Value Normalization
- **Area:** [Crypto/1 §7](crypto-v1.md#7-approval-signatures), [docs/spikes/P0-S5.md](../spikes/P0-S5.md)
- **Status:** **CLOSED (Empirically verified in P0-S5)**
- **Resolution:** The host verifier (`@remora/crypto`) MUST verify P-256 DER signatures with `lowS: false` to guarantee compatibility with all Android OEM TEE/StrongBox implementations.
- **Owners:** `P0-S5` & `P1-C1`.

### 9. Newest-Wins WebSocket Replacement Race Conditions
- **Area:** [RLY/1 §5](relay-v1.md), [docs/spikes/P0-S3.md](../spikes/P0-S3.md)
- **Status:** **CLOSED (Empirically verified in P0-S3)**
- **Resolution:** The Durable Object AccountHub enforces strict newest-wins semantics by tag lookup: when a new authenticated socket connects for endpoint ID $X$, any existing socket tagged with $X$ is closed with WebSocket close code `4409` (`Client Replaced`) before accepting frames on the new socket.
- **Owners:** `P0-S3` & `P1-R1`.

### 10. File Reading Confinement in Policy Guard
- **Area:** [RCP/1 §8](rcp-v1.md), [Blueprint §8.7](../blueprint.md#87-policy-guard)
- **Status:** **CLOSED (Adopted in Host Policy Guard architecture)**
- **Resolution:** Remora Policy Guard on the host must canonicalize all paths using `fs.realpath` and enforce that target files reside strictly within one of the user's allowlisted `roots` before invoking the underlying dsh controller.
- **Owners:** `P3-H2`.
