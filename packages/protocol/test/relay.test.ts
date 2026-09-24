import { describe, expect, it } from 'vitest'
import {
  AuthFrameSchema,
  ChallengeFrameSchema,
  CloseCodes,
  ControlFrameSchema,
  decodeDataFrame,
  encodeDataFrame,
  PeerKind,
  ReadyFrameSchema,
  RelayErrorCodes,
  RLY_SUBPROTOCOL,
  RLY_VERSION,
} from '../src/relay/index.js'
import { DATA_FRAME_HEADER_BYTES, MAX_DATA_FRAME_BYTES } from '../src/limits.js'

describe('RLY/1 constants', () => {
  it('defines correct protocol version and subprotocol', () => {
    expect(RLY_VERSION).toBe(1)
    expect(RLY_SUBPROTOCOL).toBe('remora.rly.v1')
  })

  it('defines required close codes per spec §9', () => {
    expect(CloseCodes.NORMAL).toBe(1000)
    expect(CloseCodes.AUTH_FAILED).toBe(4401)
    expect(CloseCodes.FORBIDDEN).toBe(4403)
    expect(CloseCodes.NOT_FOUND).toBe(4404)
    expect(CloseCodes.AUTH_TIMEOUT).toBe(4408)
    expect(CloseCodes.CLIENT_REPLACED).toBe(4409)
    expect(CloseCodes.RATE_LIMITED).toBe(4429)
  })

  it('defines relay error codes', () => {
    expect(RelayErrorCodes.BAD_REQUEST).toBe('bad_request')
    expect(RelayErrorCodes.UNAUTHORIZED).toBe('unauthorized')
    expect(RelayErrorCodes.NOT_LINKED).toBe('not_linked')
    expect(RelayErrorCodes.PEER_OFFLINE).toBe('peer_offline')
    expect(RelayErrorCodes.TOO_LARGE).toBe('too_large')
  })
})

describe('RLY/1 control frames', () => {
  it('validates challenge frame', () => {
    const raw = {
      t: 'challenge',
      v: 1,
      nonce: 'abcd1234nonce',
      time: 1790000000,
    }
    const parsed = ChallengeFrameSchema.parse(raw)
    expect(parsed.nonce).toBe('abcd1234nonce')
    expect(ControlFrameSchema.parse(raw)).toEqual(parsed)
  })

  it('validates auth frame', () => {
    const raw = {
      t: 'auth',
      v: 1,
      kind: 'host',
      id: 'h_abcdefghijklmnopqrstuvwx',
      sig: 'sig_test_123',
    }
    const parsed = AuthFrameSchema.parse(raw)
    expect(parsed.kind).toBe('host')
    expect(ControlFrameSchema.parse(raw)).toEqual(parsed)
  })

  it('validates ready frame with peers', () => {
    const raw = {
      t: 'ready',
      v: 1,
      id: 'h_abcdefghijklmnopqrstuvwx',
      peers: [
        {
          id: 'd_12345678901234567890123456',
          kind: 'device',
          name: 'Pixel 8',
          online: true,
          lastSeenAt: 1790000000,
        },
      ],
    }
    const parsed = ReadyFrameSchema.parse(raw)
    expect(parsed.peers.length).toBe(1)
    expect(ControlFrameSchema.parse(raw)).toEqual(parsed)
  })
})

describe('RLY/1 binary data frame codec', () => {
  const dummyPeerId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
  const dummyPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x42])

  it('encodes and decodes data frame roundtrip', () => {
    const encoded = encodeDataFrame({
      channel: 42,
      peerKind: PeerKind.DEVICE,
      peerId: dummyPeerId,
      payload: dummyPayload,
    })

    expect(encoded.length).toBe(DATA_FRAME_HEADER_BYTES + dummyPayload.length)

    const decoded = decodeDataFrame(encoded)
    expect(decoded.version).toBe(1)
    expect(decoded.type).toBe(1)
    expect(decoded.channel).toBe(42)
    expect(decoded.peerKind).toBe(PeerKind.DEVICE)
    expect(Array.from(decoded.peerId)).toEqual(Array.from(dummyPeerId))
    expect(Array.from(decoded.payload)).toEqual(Array.from(dummyPayload))
  })

  it('rejects frame with invalid peerId length', () => {
    expect(() =>
      encodeDataFrame({
        channel: 1,
        peerKind: PeerKind.HOST,
        peerId: new Uint8Array([1, 2, 3]),
        payload: dummyPayload,
      }),
    ).toThrow('peerId must be exactly 16 bytes')
  })

  it('rejects decoding truncated header', () => {
    expect(() => decodeDataFrame(new Uint8Array(20))).toThrow('DataFrame too short')
  })

  it('rejects frame exceeding MAX_DATA_FRAME_BYTES', () => {
    const oversize = new Uint8Array(MAX_DATA_FRAME_BYTES + 1)
    expect(() => decodeDataFrame(oversize)).toThrow('DataFrame exceeds maximum size')
  })
})
