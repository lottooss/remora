/**
 * Host-side relay wiring: owns the authenticated {@link RelayLink} session to
 * the self-hosted relay and forwards decoded RLY/1 data frames to the
 * {@link ChannelManager}. The relay only ever sees ciphertext — nothing here
 * parses SC/1 records or RCP payloads.
 */
import { encodeBase64Url } from '@remora/crypto'
import { decodeDataFrame, type DataFrame } from '@remora/protocol'
import { RelayLink, type RelayLinkState } from '@remora/relay-link'
import type { ChannelManager } from '../channel/index.ts'
import type { HostIdentity } from '../identity/index.ts'

export interface HostRelayOptions {
  /** Relay WebSocket endpoint, e.g. `wss://remora.example.workers.dev` */
  relayUrl: string
  /** Host identity: endpoint id plus the Ed25519 relay credential. */
  identity: HostIdentity
  /** Called on every connection state change (for CLI status output). */
  onStatusChange?: (status: RelayLinkState) => void
  /** Called for relay failures and frame-handling errors; never receives content. */
  onError?: (error: unknown) => void
}

export function normalizeRelayWsUrl(inputUrl: string): string {
  const url = new URL(inputUrl)
  if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  } else if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  }
  if (url.pathname === '/' || url.pathname === '') {
    url.pathname = '/v1/connect'
  }
  return url.toString()
}

export async function enrollHost(
  relayHttpUrl: string,
  enrollSecret: string,
  identity: HostIdentity,
  hostName: string,
): Promise<{ v: number; id: string }> {
  const url = new URL('/v1/enroll/host', relayHttpUrl)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${enrollSecret}`,
    },
    body: JSON.stringify({
      v: 1,
      relayPub: encodeBase64Url(identity.relayKeypair.publicKey),
      name: hostName,
      platform: process.platform,
    }),
  })
  if (!res.ok) {
    throw new Error(`Host enrollment failed (${res.status}): ${await res.text()}`)
  }
  return (await res.json()) as { v: number; id: string }
}

export class HostRelayConnection {
  readonly link: RelayLink
  private channelManager: ChannelManager | null = null

  constructor(private readonly options: HostRelayOptions) {
    this.link = new RelayLink({
      url: normalizeRelayWsUrl(options.relayUrl),
      endpointId: options.identity.hostId,
      endpointKind: 'host',
      relayPrivateKey: options.identity.relayKeypair.privateKey,
    })

    this.link.on('state', (status: RelayLinkState) => {
      this.options.onStatusChange?.(status)
    })

    // An EventEmitter throws on an unhandled 'error' event, so it always has a listener.
    this.link.on('error', (error: unknown) => {
      this.options.onError?.(error)
    })

    this.link.on('data', (frame: DataFrame) => {
      const channels = this.channelManager
      if (!channels) return
      void channels.handleDataFrame(frame).catch((error: unknown) => this.options.onError?.(error))
    })
  }

  attachChannelManager(channelManager: ChannelManager): void {
    this.channelManager = channelManager
  }

  get isConnected(): boolean {
    return this.link.state === 'ready'
  }

  get status(): RelayLinkState {
    return this.link.state
  }

  start(): void {
    this.link.start()
  }

  async stop(): Promise<void> {
    await this.link.stop()
  }

  /**
   * Sends one data frame the ChannelManager already encoded with
   * `encodeDataFrame`. `RelayLink` only offers field-level `sendData`, so the
   * bytes are decoded back into their fields here; anything that is not a
   * well-formed frame throws (fail closed).
   */
  sendFrameBytes(frameBytes: Uint8Array): void {
    const frame = decodeDataFrame(frameBytes)
    this.link.sendData(
      { peerKind: frame.peerKind, peerId: frame.peerId },
      frame.channel,
      frame.payload,
    )
  }
}
