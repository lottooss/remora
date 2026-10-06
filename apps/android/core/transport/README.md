# Android transport

ConnectionManager owns one foreground host connection. It copies caller-owned keys synchronously in connect, authenticates the relay, performs a fresh Noise handshake, and completes hello before publishing rcpClient. Reconnection and channel rekey dispose old clients and fail pending requests. disconnect closes the relay and wipes owned secret arrays. Supply an application lifecycle scope and call disconnect when the foreground timeout expires.

RcpClient.openStream is cold: collection creates a host stream, cancellation sends cancel, and errors/end propagate to the collector. Responses register their stream before completing the request. A bounded buffer accepts baselines emitted by current hosts before the stream-open response; overflow fails the channel so callers can resume durable cursors. No durable items are silently dropped.

SecureChannel checks the source peer id against the pinned host as well as the channel id, serializes send nonces, bounds RCP records, and closes on decryption/sequence/size failures. Existing shared crypto encodings are preserved; any difference between those APIs and prose specifications requires a coordinated contract change.
