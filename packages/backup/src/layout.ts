import type { RefsState } from '@git-forge/core'

export const README_KEY = 'README.txt'

export const keyRecordKey = (run: string): string => `keys/${run}.json`

export const OBJECTS_PREFIX = 'objects/'

export const objectKey = (name: string): string => `${OBJECTS_PREFIX}${name.slice(0, 2)}/${name}`

export const objectNameOf = (key: string): string | null => {
  const match = /^objects\/[0-9a-f]{2}\/([0-9a-f]{64})$/.exec(key)
  return match ? (match[1] as string) : null
}

export const SNAPSHOTS_PREFIX = 'snapshots/'

export const snapshotKey = (run: string, tag: string): string => `${SNAPSHOTS_PREFIX}${run}-${tag.slice(0, 16)}`

export const seenKey = (tag: string): string => `seen/${tag}`

export const runId = (at: Date): string =>
  `${at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${Array.from(crypto.getRandomValues(new Uint8Array(4)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`

export type SnapshotPack = {
  readonly name: string
  readonly size: number
  readonly object: string
  readonly index: { readonly size: number; readonly object: string }
}

export type SnapshotLfsObject = {
  readonly oid: string
  readonly size: number
  readonly object: string
}

export type SnapshotData = {
  readonly format: string
  readonly size: number
  readonly sha256: string
  readonly object: string
}

export type SnapshotRepository = {
  readonly owner: string
  readonly name: string
  readonly refs: RefsState
  readonly packs: readonly SnapshotPack[]
  readonly lfs: readonly SnapshotLfsObject[]
  readonly data?: SnapshotData
}

export type Snapshot = {
  readonly format: 'git-forge-backup-snapshot'
  readonly version: 1
  readonly run: string
  readonly created: string
  readonly instance?: string
  readonly repository: SnapshotRepository
}

export const BUCKET_README = `This bucket holds encrypted git-forge backups.

Every object under objects/ and snapshots/ is encrypted (AES-256-GCM in
segments) under a key that only the holder of the offline recovery key
(X25519) can derive; keys/<run>.json holds the public half of each run's key
agreement. Nothing here is readable without the recovery key.

Restore a repository with

  git forge backup restore --from <dir or s3 url> --key recovery.jwk <owner>/<name> <dir>

or, into a forge running on Node, git-forge-node restore <owner>/<name>.
The format is described in docs/design.md of git-forge ("Encrypted backups").
`
