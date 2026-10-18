export class ByteLru<K, V> {
  readonly #entries = new Map<K, { readonly value: V; readonly size: number }>()
  readonly #budget: number
  #bytes = 0

  constructor(budget: number) {
    this.#budget = budget
  }

  get bytes(): number {
    return this.#bytes
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  has(key: K): boolean {
    return this.#entries.has(key)
  }

  set(key: K, value: V, size: number): void {
    const existing = this.#entries.get(key)
    if (existing) {
      this.#entries.delete(key)
      this.#bytes -= existing.size
    }
    if (size > this.#budget) return
    this.#entries.set(key, { value, size })
    this.#bytes += size
    for (const [oldest, entry] of this.#entries) {
      if (this.#bytes <= this.#budget) break
      this.#entries.delete(oldest)
      this.#bytes -= entry.size
    }
  }

  clear(): void {
    this.#entries.clear()
    this.#bytes = 0
  }
}
