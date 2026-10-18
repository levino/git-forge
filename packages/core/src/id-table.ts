import { fromHex, toHex } from './bytes.ts'
import type { ObjectId } from './hash.ts'

export const ID_BYTES = 20

const slotOf = (ids: Uint8Array, offset: number, mask: number): number =>
  (((ids[offset] as number) << 24) | ((ids[offset + 1] as number) << 16) | ((ids[offset + 2] as number) << 8) | (ids[offset + 3] as number)) & mask

const sameId = (a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number): boolean => {
  for (let i = 0; i < ID_BYTES; i++) if (a[aOffset + i] !== b[bOffset + i]) return false
  return true
}

export class IdSet {
  #keys: Uint8Array
  #used: Uint8Array
  #mask: number
  #size = 0

  constructor(capacity = 1024) {
    let slots = 16
    while (slots < capacity * 2) slots *= 2
    this.#keys = new Uint8Array(slots * ID_BYTES)
    this.#used = new Uint8Array(slots)
    this.#mask = slots - 1
  }

  get size(): number {
    return this.#size
  }

  #find(bytes: Uint8Array, offset: number): number {
    let slot = slotOf(bytes, offset, this.#mask)
    while (this.#used[slot] && !sameId(this.#keys, slot * ID_BYTES, bytes, offset)) slot = (slot + 1) & this.#mask
    return slot
  }

  hasBytes(bytes: Uint8Array, offset = 0): boolean {
    return this.#used[this.#find(bytes, offset)] === 1
  }

  has(id: ObjectId): boolean {
    return this.hasBytes(fromHex(id))
  }

  addBytes(bytes: Uint8Array, offset = 0): boolean {
    const slot = this.#find(bytes, offset)
    if (this.#used[slot]) return false
    this.#keys.set(bytes.subarray(offset, offset + ID_BYTES), slot * ID_BYTES)
    this.#used[slot] = 1
    this.#size++
    if (this.#size * 2 > this.#used.length) this.#grow()
    return true
  }

  add(id: ObjectId): boolean {
    return this.addBytes(fromHex(id))
  }

  #grow(): void {
    const keys = this.#keys
    const used = this.#used
    this.#keys = new Uint8Array(keys.length * 2)
    this.#used = new Uint8Array(used.length * 2)
    this.#mask = this.#used.length - 1
    this.#size = 0
    for (let slot = 0; slot < used.length; slot++) if (used[slot]) this.addBytes(keys, slot * ID_BYTES)
  }

  *values(): Generator<ObjectId> {
    for (let slot = 0; slot < this.#used.length; slot++) {
      if (this.#used[slot]) yield toHex(this.#keys.subarray(slot * ID_BYTES, (slot + 1) * ID_BYTES))
    }
  }
}

export class IdIndex {
  readonly #ids: () => Uint8Array
  #slots: Int32Array
  #mask: number
  #size = 0

  constructor(ids: () => Uint8Array, capacity = 1024) {
    this.#ids = ids
    let slots = 16
    while (slots < capacity * 2) slots *= 2
    this.#slots = new Int32Array(slots).fill(-1)
    this.#mask = slots - 1
  }

  getBytes(bytes: Uint8Array, offset = 0): number {
    const ids = this.#ids()
    let slot = slotOf(bytes, offset, this.#mask)
    for (;;) {
      const entry = this.#slots[slot] as number
      if (entry === -1) return -1
      if (sameId(ids, entry * ID_BYTES, bytes, offset)) return entry
      slot = (slot + 1) & this.#mask
    }
  }

  get(id: ObjectId): number {
    return this.getBytes(fromHex(id))
  }

  add(entry: number): void {
    const ids = this.#ids()
    let slot = slotOf(ids, entry * ID_BYTES, this.#mask)
    while (this.#slots[slot] !== -1) {
      if (sameId(ids, (this.#slots[slot] as number) * ID_BYTES, ids, entry * ID_BYTES)) return
      slot = (slot + 1) & this.#mask
    }
    this.#slots[slot] = entry
    this.#size++
    if (this.#size * 2 > this.#slots.length) this.#grow()
  }

  #grow(): void {
    const old = this.#slots
    this.#slots = new Int32Array(old.length * 2).fill(-1)
    this.#mask = this.#slots.length - 1
    this.#size = 0
    for (const entry of old) if (entry !== -1) this.add(entry)
  }
}
