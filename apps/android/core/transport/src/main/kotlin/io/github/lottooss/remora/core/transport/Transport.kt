package io.github.lottooss.remora.core.transport

/** Relay client, secure channel (initiator), and RCP client. Implementation: task P2-K1. */
enum class ConnectionState { Idle, Connecting, Authenticating, Handshaking, Ready, Backoff }
