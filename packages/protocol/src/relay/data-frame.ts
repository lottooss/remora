import { DATA_FRAME_HEADER_BYTES, MAX_DATA_FRAME_BYTES } from '../limits.js'
import { PeerKind, RLY_VERSION } from './constants.js'

export const DATA_FRAME_TYPE = 0x01

export interface DataFrame {
  version: number
  type: number
  channel: number
  peerKind: PeerKind
  peerId: Uint8Array // 16 bytes
  payload: Uint8Array
}

export class DataFrameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DataFrameError'
  }
}

/**
 * Encodes a relay binary data frame into a Uint8Array.
 * Uses exact 28-byte header structure defined in RLY/1 §6.
 */
export function encodeDataFrame(frame: {
  channel: number
  peerKind: PeerKind
  peerId: Uint8Array
  payload: Uint8Array
}): Uint8Array {
  if (frame.peerId.length !== 16) {
    throw new DataFrameError(`peerId must be exactly 16 bytes, got ${frame.peerId.length}`)
  }

  const totalLength = DATA_FRAME_HEADER_BYTES + frame.payload.length
  if (totalLength > MAX_DATA_FRAME_BYTES) {
    throw new DataFrameError(`DataFrame total size (${totalLength}) exceeds maximum limit (${MAX_DATA_FRAME_BYTES})`)
  }

  const buffer = new Uint8Array(totalLength)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  // Byte 0: version
  view.setUint8(0, RLY_VERSION)
  // Byte 1: type
  view.setUint8(1, DATA_FRAME_TYPE)
  // Bytes 2-3: reserved (0x0000)
  view.setUint16(2, 0, false)
  // Bytes 4-7: channel (u32 big-endian)
  view.setUint32(4, frame.channel, false)
  // Byte 8: peer kind
  view.setUint8(8, frame.peerKind)
  // Bytes 9-24: peer id (16 bytes)
  buffer.set(frame.peerId, 9)
  // Bytes 25-27: reserved (3 zero bytes)
  buffer[25] = 0
  buffer[26] = 0
  buffer[27] = 0
  // Bytes 28+: payload
  buffer.set(frame.payload, 28)

  return buffer
}

/**
 * Decodes a relay binary data frame from a Uint8Array.
 * Throws DataFrameError if the input is malformed, too short, or exceeds max frame size.
 */
export function decodeDataFrame(bytes: Uint8Array): DataFrame {
  if (bytes.length < DATA_FRAME_HEADER_BYTES) {
    throw new DataFrameError(`DataFrame too short: ${bytes.length} bytes (minimum ${DATA_FRAME_HEADER_BYTES})`)
  }
  if (bytes.length > MAX_DATA_FRAME_BYTES) {
    throw new DataFrameError(`DataFrame exceeds maximum size: ${bytes.length} bytes (maximum ${MAX_DATA_FRAME_BYTES})`)
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint8(0)
  if (version !== RLY_VERSION) {
    throw new DataFrameError(`Unsupported protocol version: ${version}`)
  }

  const type = view.getUint8(1)
  if (type !== DATA_FRAME_TYPE) {
    throw new DataFrameError(`Unsupported frame type: ${type}`)
  }

  const channel = view.getUint32(4, false)
  const rawPeerKind = view.getUint8(8)
  if (rawPeerKind !== PeerKind.HOST && rawPeerKind !== PeerKind.DEVICE) {
    throw new DataFrameError(`Invalid peer kind: ${rawPeerKind}`)
  }

  const peerId = bytes.slice(9, 25)
  const payload = bytes.slice(DATA_FRAME_HEADER_BYTES)

  return {
    version,
    type,
    channel,
    peerKind: rawPeerKind,
    peerId,
    payload,
  }
}
