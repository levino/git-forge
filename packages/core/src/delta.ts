const readVarint = (delta: Uint8Array, start: number): { value: number; next: number } => {
  let value = 0
  let shift = 0
  let offset = start
  for (;;) {
    const byte = delta[offset++]
    if (byte === undefined) throw new Error('truncated delta')
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if ((byte & 0x80) === 0) return { value, next: offset }
  }
}

export const deltaResultSize = (delta: Uint8Array): number => {
  const source = readVarint(delta, 0)
  return readVarint(delta, source.next).value
}

export const applyDelta = (base: Uint8Array, delta: Uint8Array): Uint8Array => {
  const source = readVarint(delta, 0)
  if (source.value !== base.length) throw new Error('delta base size mismatch')
  const target = readVarint(delta, source.next)
  const out = new Uint8Array(target.value)
  let offset = target.next
  let written = 0
  while (offset < delta.length) {
    const op = delta[offset++] as number
    if (op & 0x80) {
      let copyOffset = 0
      let copySize = 0
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) copyOffset |= (delta[offset++] as number) << (bit * 8)
      }
      for (let bit = 0; bit < 3; bit++) {
        if (op & (1 << (bit + 4))) copySize |= (delta[offset++] as number) << (bit * 8)
      }
      copyOffset >>>= 0
      if (copySize === 0) copySize = 0x10000
      if (copyOffset + copySize > base.length || written + copySize > out.length) throw new Error('delta copy out of range')
      out.set(base.subarray(copyOffset, copyOffset + copySize), written)
      written += copySize
    } else if (op > 0) {
      if (offset + op > delta.length || written + op > out.length) throw new Error('delta insert out of range')
      out.set(delta.subarray(offset, offset + op), written)
      offset += op
      written += op
    } else {
      throw new Error('invalid delta opcode 0')
    }
  }
  if (written !== out.length) throw new Error('delta result size mismatch')
  return out
}
