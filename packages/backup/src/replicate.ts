import { readAll, type Storage } from '@git-forge/core'
import { keyRecordKey, objectNameOf, README_KEY, SNAPSHOTS_PREFIX } from './layout.ts'
import { headerLength, sealedRun, sealedSize } from './seal.ts'

const PREFIXES = ['keys/', 'objects/', SNAPSHOTS_PREFIX, 'seen/']

export type ReplicationResult = {
  readonly copied: number
  readonly copiedBytes: number
  readonly present: number
}

export const replicateBackup = async (from: Storage, to: Storage): Promise<ReplicationResult> => {
  let copied = 0
  let copiedBytes = 0
  let present = 0
  const copy = async (key: string, size: number) => {
    const existing = await to.head(key)
    if (existing) {
      if (existing.size !== size) throw new Error(`${key} differs in size between the two backups`)
      present++
      return
    }
    const object = await from.get(key)
    if (!object) return
    const result = await to.put(key, object.body, object.size, { ifNoneMatch: '*', contentType: 'application/octet-stream' })
    if (result.ok) {
      copied++
      copiedBytes += object.size
    } else present++
  }
  for (const prefix of PREFIXES) for await (const info of from.list(prefix)) await copy(info.key, info.size)
  const readme = await from.head(README_KEY)
  if (readme) await copy(README_KEY, readme.size)
  return { copied, copiedBytes, present }
}

export type StructureProblem = {
  readonly key: string
  readonly problem: string
}

export type StructureReport = {
  readonly objects: number
  readonly snapshots: number
  readonly runs: number
  readonly bytes: number
  readonly problems: readonly StructureProblem[]
}

const HEAD_BYTES = 512

export const checkBackupStructure = async (backup: Storage): Promise<StructureReport> => {
  const problems: StructureProblem[] = []
  const runs = new Map<string, boolean>()
  let objects = 0
  let snapshots = 0
  let bytes = 0
  const check = async (key: string, size: number) => {
    bytes += size
    const stored = await backup.get(key, { offset: 0, length: HEAD_BYTES })
    if (!stored) return problems.push({ key, problem: 'listed but missing' })
    const head = await readAll(stored.body)
    const run = sealedRun(head)
    if (!run) return problems.push({ key, problem: 'not a sealed backup object' })
    let known = runs.get(run)
    if (known === undefined) {
      known = (await backup.head(keyRecordKey(run))) !== null
      runs.set(run, known)
    }
    if (!known) problems.push({ key, problem: `key record of run ${run} is missing` })
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    const at = headerLength(run) - 28
    const segment = view.getUint32(at)
    const plain = view.getUint32(at + 4) * 2 ** 32 + view.getUint32(at + 8)
    if (sealedSize(plain, run, segment) !== size) problems.push({ key, problem: 'size does not match its header' })
  }
  for await (const info of backup.list('objects/')) {
    if (!objectNameOf(info.key)) {
      problems.push({ key: info.key, problem: 'unexpected key' })
      continue
    }
    objects++
    await check(info.key, info.size)
  }
  for await (const info of backup.list(SNAPSHOTS_PREFIX)) {
    snapshots++
    await check(info.key, info.size)
  }
  return { objects, snapshots, runs: runs.size, bytes, problems }
}
