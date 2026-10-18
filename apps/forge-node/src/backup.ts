import { mkdir } from 'node:fs/promises'
import { type Database, createAccountsStore, sql } from '@git-forge/accounts'
import {
  type BackupResult,
  backupRepositories,
  exportRepositoryData,
  findSnapshot,
  importRepositoryData,
  nameKeyFromSecret,
  parseRecoveryPrivateKey,
  parseRecoveryPublicKey,
  parseRepositoryExport,
  type RecoveryPublicKey,
  restoreSnapshot,
  runKeys,
  storageSink,
} from '@git-forge/backup'
import { readRefs, type RepositoryName, type Storage } from '@git-forge/core'
import { FsStorage, nodeDigests } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { ConfigurationError } from 'forge-worker/config'
import { type NodeVars, joinPath, present, type StorageConfig, s3StorageConfig } from './config.ts'
import { type CronSchedule, CronError, parseCron } from './cron.ts'

export const DEFAULT_BACKUP_SCHEDULE = '47 3 * * *'

export type BackupConfig = {
  readonly recipient: RecoveryPublicKey
  readonly secret: string
  readonly repositories: readonly string[]
  readonly schedule: CronSchedule | null
  readonly target: StorageConfig
}

const PATTERN = /^(\*|[A-Za-z0-9][A-Za-z0-9._-]*\/(\*|[A-Za-z0-9][A-Za-z0-9._-]*))$/

export const parseBackupConfig = (vars: NodeVars, dataDir = present(vars.DATA_DIR) ?? './data'): BackupConfig | null => {
  const key = present(vars.BACKUP_RECOVERY_KEY)
  if (key === undefined) return null
  let recipient: RecoveryPublicKey
  try {
    recipient = parseRecoveryPublicKey(key)
  } catch (error) {
    throw new ConfigurationError(`BACKUP_RECOVERY_KEY: ${(error as Error).message}`)
  }
  if ('d' in (JSON.parse(key) as object)) throw new ConfigurationError('BACKUP_RECOVERY_KEY must be the public key; keep the private key offline')
  const secret = present(vars.BACKUP_SECRET)
  if (secret === undefined || secret.length < 32) throw new ConfigurationError('BACKUP_SECRET must have at least 32 characters')
  const repositories = (present(vars.BACKUP_REPOSITORIES) ?? '*').split(',').map((entry) => entry.trim()).filter(Boolean)
  for (const pattern of repositories) if (!PATTERN.test(pattern)) throw new ConfigurationError(`BACKUP_REPOSITORIES: invalid entry ${pattern}`)
  const scheduleText = present(vars.BACKUP_SCHEDULE) ?? DEFAULT_BACKUP_SCHEDULE
  let schedule: CronSchedule | null = null
  if (scheduleText !== 'off') {
    try {
      schedule = parseCron(scheduleText)
    } catch (error) {
      if (error instanceof CronError) throw new ConfigurationError(`BACKUP_SCHEDULE: ${error.message}`)
      throw error
    }
  }
  const kind = present(vars.BACKUP_STORAGE) ?? 'fs'
  let target: StorageConfig
  if (kind === 'fs') target = { kind, dir: present(vars.BACKUP_DIR) ?? joinPath(dataDir, 'backup') }
  else if (kind === 's3') target = { kind, config: s3StorageConfig(vars, 'BACKUP_S3_', 'BACKUP_STORAGE=s3') }
  else throw new ConfigurationError('BACKUP_STORAGE must be fs or s3')
  return { recipient, secret, repositories, schedule, target }
}

export const openBackupStorage = async (target: StorageConfig): Promise<Storage> => {
  if (target.kind === 's3') return new S3Storage(target.config)
  await mkdir(target.dir, { recursive: true })
  return new FsStorage(target.dir)
}

export const matchesPattern = (pattern: string, repository: RepositoryName): boolean => {
  if (pattern === '*') return true
  const [owner, name] = pattern.split('/') as [string, string]
  return owner.toLowerCase() === repository.owner.toLowerCase() && (name === '*' || name.toLowerCase() === repository.name.toLowerCase())
}

export const selectRepositories = async (db: Database, patterns: readonly string[]): Promise<RepositoryName[]> => {
  const rows = await db.all<{ owner: string; name: string }>(
    sql('SELECT a.login AS owner, r.name AS name FROM repositories r JOIN accounts a ON a.id = r.owner_id ORDER BY a.login, r.name'),
  )
  return rows.map((row) => ({ owner: row.owner, name: row.name })).filter((repository) => patterns.some((pattern) => matchesPattern(pattern, repository)))
}

export type BackupRunOptions = {
  readonly storage: Storage
  readonly db: Database
  readonly config: BackupConfig
  readonly instance?: string
  readonly now?: () => Date
}

export const runBackup = async (options: BackupRunOptions): Promise<BackupResult[]> => {
  const all = await selectRepositories(options.db, options.config.repositories)
  const repositories: RepositoryName[] = []
  for (const repository of all) if (await readRefs(options.storage, repository)) repositories.push(repository)
  return backupRepositories({
    source: options.storage,
    repositories,
    storage: await openBackupStorage(options.config.target),
    recipient: options.config.recipient,
    names: await nameKeyFromSecret(options.config.secret),
    data: (repository) => exportRepositoryData(options.db, repository),
    ...(options.instance ? { instance: options.instance } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
}

export type RestoreCommand = {
  readonly repository: RepositoryName
  readonly as: RepositoryName
  readonly privateKey: string
  readonly snapshot?: string
}

export type RestoreOutcome = {
  readonly snapshot: string
  readonly created: string
  readonly packs: number
  readonly lfs: number
  readonly rows: number
  readonly skipped: number
}

export const restoreIntoInstance = async (options: { readonly storage: Storage; readonly db: Database; readonly backup: Storage } & RestoreCommand): Promise<RestoreOutcome> => {
  const keys = runKeys(options.backup, parseRecoveryPrivateKey(options.privateKey))
  const { key, snapshot } = await findSnapshot(options.backup, keys, options.repository, options.snapshot)
  const store = createAccountsStore(options.db)
  if (await store.findRepository(options.as.owner, options.as.name)) throw new ConfigurationError(`${options.as.owner}/${options.as.name} exists in the database`)
  if (await readRefs(options.storage, options.as)) throw new ConfigurationError(`${options.as.owner}/${options.as.name} exists in the storage`)
  const sink = await storageSink(options.storage, options.as, snapshot.repository.refs)
  const result = await restoreSnapshot(options.backup, keys, snapshot.repository, sink, nodeDigests)
  const exported = result.data ? parseRepositoryExport(result.data) : null
  const owner = (await store.findAccount(options.as.owner)) ?? (await store.createUser({ login: options.as.owner }))
  const visibility = exported?.repository.visibility === 'public' ? 'public' : 'private'
  const { id } = await store.createRepository({ ownerId: owner.id, name: options.as.name, visibility })
  const imported = exported ? await importRepositoryData(options.db, id, exported) : { rows: 0, skipped: 0 }
  return { snapshot: key, created: snapshot.created, packs: result.packs, lfs: result.lfs, ...imported }
}
