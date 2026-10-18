import { toHex } from './bytes.ts'
import { createSha1 } from './hash.ts'
import { ID_BYTES } from './id-table.ts'
import { streamFrom } from './pack-indexer.ts'
import { writeIndexColumns } from './pack-index.ts'
import { concatenatePacks, planConcatenation } from './pack-writer.ts'
import { type LoadedPack, ObjectDatabase, packKey, type RepositoryName } from './repository.ts'
import type { Storage } from './storage.ts'

export type PackSize = {
  readonly name: string
  readonly size: number
}

export const planCompaction = (packs: readonly PackSize[], factor = 2): string[] => {
  const sorted = [...packs].sort((a, b) => a.size - b.size || (a.name < b.name ? -1 : 1))
  let count = 0
  for (let i = sorted.length - 1; i > 0; i--) {
    if ((sorted[i] as PackSize).size < factor * (sorted[i - 1] as PackSize).size) {
      count = i + 1
      break
    }
  }
  if (count === 0) return []
  let total = sorted.slice(0, count).reduce((sum, pack) => sum + pack.size, 0)
  while (count < sorted.length && (sorted[count] as PackSize).size < factor * total) {
    total += (sorted[count] as PackSize).size
    count++
  }
  return count < 2 ? [] : sorted.slice(0, count).map((pack) => pack.name)
}

export type CompactionOptions = {
  readonly factor?: number
  readonly maxBytes?: number
  readonly all?: boolean
}

export type CompactionResult = {
  readonly pack: string
  readonly merged: readonly string[]
  readonly objects: number
  readonly duplicates: number
  readonly bytes: number
}

export const compactRepository = async (storage: Storage, repo: RepositoryName, options: CompactionOptions = {}): Promise<CompactionResult | null> => {
  const odb = new ObjectDatabase(storage, repo)
  const packs = await odb.packs()
  const sizes: PackSize[] = []
  for (const pack of packs) sizes.push({ name: pack.name, size: await odb.packSize(pack) })
  const chosen = new Set(options.all ? (sizes.length > 1 ? sizes.map((pack) => pack.name) : []) : planCompaction(sizes, options.factor ?? 2))
  if (chosen.size < 2) return null
  const total = sizes.filter((pack) => chosen.has(pack.name)).reduce((sum, pack) => sum + pack.size, 0)
  if (options.maxBytes !== undefined && total > options.maxBytes) return null
  const selected: LoadedPack[] = packs.filter((pack) => chosen.has(pack.name))
  const plan = planConcatenation(selected)
  const ids = new Uint8Array(plan.count * ID_BYTES)
  const offsets = new Float64Array(plan.count)
  const crcs = new Uint32Array(plan.count)
  let entries = 0
  let size = 0
  const hash = createSha1()
  for await (const chunk of concatenatePacks(odb, plan, (entry) => {
    ids.set(entry.id, entries * ID_BYTES)
    offsets[entries] = entry.offset
    crcs[entries] = entry.crc
    entries++
  })) {
    hash.update(chunk)
    size += chunk.length
  }
  if (entries !== plan.count) throw new Error(`compaction wrote ${entries} of ${plan.count} objects`)
  const checksum = hash.digest()
  const name = `pack-${toHex(checksum)}.pack`
  async function* content(): AsyncGenerator<Uint8Array> {
    yield* concatenatePacks(odb, plan)
    yield checksum
  }
  await storage.put(packKey(repo, name), streamFrom(content()), size + 20, { contentType: 'application/x-git-packed-objects' })
  const index = writeIndexColumns({ count: plan.count, ids, offsets, crcs }, checksum)
  await storage.put(packKey(repo, name.replace(/\.pack$/, '.idx')), index, index.length, { contentType: 'application/x-git-packed-objects-toc' })
  const replaced = await odb.updatePackList((names) => {
    if (![...chosen].every((merged) => names.includes(merged))) return null
    const position = names.findIndex((existing) => chosen.has(existing))
    const rest = names.filter((existing) => !chosen.has(existing) && existing !== name)
    return [...rest.slice(0, position), name, ...rest.slice(position)]
  })
  if (!replaced) return null
  return { pack: name, merged: [...chosen], objects: plan.count, duplicates: plan.dropped, bytes: size + 20 }
}
