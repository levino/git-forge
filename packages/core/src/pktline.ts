import { concat, fromUtf8, utf8 } from './bytes.ts'

export const FLUSH = utf8('0000')
export const DELIM = utf8('0001')
export const RESPONSE_END = utf8('0002')

const MAX_PAYLOAD = 65516

export const pkt = (payload: string | Uint8Array): Uint8Array => {
  const data = typeof payload === 'string' ? utf8(payload) : payload
  if (data.length > MAX_PAYLOAD) throw new Error('pkt-line payload too large')
  return concat([utf8((data.length + 4).toString(16).padStart(4, '0')), data])
}

export type Packet =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }

export type PacketParse = { packets: Packet[]; rest: Uint8Array }

export const parsePackets = (bytes: Uint8Array, stopAfterFlush = false): PacketParse => {
  const packets: Packet[] = []
  let offset = 0
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(fromUtf8(bytes.subarray(offset, offset + 4)), 16)
    if (Number.isNaN(length)) throw new Error('invalid pkt-line length')
    if (length === 0) {
      packets.push({ kind: 'flush' })
      offset += 4
      if (stopAfterFlush) break
      continue
    }
    if (length === 1) {
      packets.push({ kind: 'delim' })
      offset += 4
      continue
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' })
      offset += 4
      continue
    }
    if (length < 4) throw new Error('invalid pkt-line length')
    if (offset + length > bytes.length) break
    packets.push({ kind: 'data', data: bytes.subarray(offset + 4, offset + length) })
    offset += length
  }
  return { packets, rest: bytes.subarray(offset) }
}

export const packetText = (packet: Packet): string | null =>
  packet.kind === 'data' ? fromUtf8(packet.data).replace(/\n$/, '') : null

export const SIDEBAND_DATA = 1
export const SIDEBAND_PROGRESS = 2
export const SIDEBAND_ERROR = 3

const SIDEBAND_CHUNK = 65515

export const sideband = (channel: number, data: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = []
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    out.push(pkt(concat([new Uint8Array([channel]), data.subarray(offset, offset + SIDEBAND_CHUNK)])))
  }
  return out
}
