import type { S3StorageConfig } from '@git-forge/s3'
import { ConfigurationError, type ForgeVars } from 'forge-worker/config'
import { type CronSchedule, CronError, parseCron } from './cron.ts'

export type NodeVars = ForgeVars & {
  readonly PORT?: string
  readonly HOST?: string
  readonly TRUST_PROXY?: string
  readonly DATA_DIR?: string
  readonly DATABASE_PATH?: string
  readonly STORAGE?: string
  readonly STORAGE_DIR?: string
  readonly S3_ENDPOINT?: string
  readonly S3_REGION?: string
  readonly S3_BUCKET?: string
  readonly S3_ACCESS_KEY_ID?: string
  readonly S3_SECRET_ACCESS_KEY?: string
  readonly S3_PREFIX?: string
  readonly S3_FORCE_PATH_STYLE?: string
  readonly SCHEDULE?: string
  readonly JOB_CONCURRENCY?: string
  readonly LFS_PUBLISH_DIR?: string
}

export type StorageConfig = { readonly kind: 'fs'; readonly dir: string } | { readonly kind: 's3'; readonly config: S3StorageConfig }

export type NodeConfig = {
  readonly port: number
  readonly host: string
  readonly trustProxy: boolean
  readonly databasePath: string
  readonly storage: StorageConfig
  readonly schedule: CronSchedule
  readonly jobConcurrency: number
  readonly lfsPublishDir: string | null
}

export const DEFAULT_PORT = 8080

export const DEFAULT_HOST = '0.0.0.0'

export const DEFAULT_DATA_DIR = './data'

export const DEFAULT_SCHEDULE = '17 3 * * *'

export const DEFAULT_JOB_CONCURRENCY = 2

const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim())

const joinPath = (dir: string, name: string): string => `${dir.replace(/\/+$/, '')}/${name}`

const integer = (name: string, value: string | undefined, fallback: number, min: number, max: number): number => {
  const text = present(value)
  if (text === undefined) return fallback
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ConfigurationError(`${name} must be an integer between ${min} and ${max}`)
  return parsed
}

const flag = (name: string, value: string | undefined): boolean => {
  const text = present(value)
  if (text === undefined || text === 'false') return false
  if (text === 'true') return true
  throw new ConfigurationError(`${name} must be true or false`)
}

const required = (vars: NodeVars, name: keyof NodeVars): string => {
  const value = present(vars[name])
  if (value === undefined) throw new ConfigurationError(`${name} is required with STORAGE=s3`)
  return value
}

const storageConfig = (vars: NodeVars, dataDir: string): StorageConfig => {
  const kind = present(vars.STORAGE) ?? 'fs'
  if (kind === 'fs') return { kind, dir: present(vars.STORAGE_DIR) ?? joinPath(dataDir, 'objects') }
  if (kind !== 's3') throw new ConfigurationError('STORAGE must be fs or s3')
  const endpoint = required(vars, 'S3_ENDPOINT')
  try {
    new URL(endpoint)
  } catch {
    throw new ConfigurationError('S3_ENDPOINT must be a URL')
  }
  const prefix = present(vars.S3_PREFIX)
  return {
    kind,
    config: {
      endpoint,
      region: present(vars.S3_REGION) ?? 'us-east-1',
      bucket: required(vars, 'S3_BUCKET'),
      accessKeyId: required(vars, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: required(vars, 'S3_SECRET_ACCESS_KEY'),
      forcePathStyle: flag('S3_FORCE_PATH_STYLE', vars.S3_FORCE_PATH_STYLE),
      ...(prefix ? { prefix } : {}),
    },
  }
}

const schedule = (value: string | undefined): CronSchedule => {
  try {
    return parseCron(present(value) ?? DEFAULT_SCHEDULE)
  } catch (error) {
    if (error instanceof CronError) throw new ConfigurationError(`SCHEDULE: ${error.message}`)
    throw error
  }
}

export const parseNodeConfig = (vars: NodeVars): NodeConfig => {
  const dataDir = present(vars.DATA_DIR) ?? DEFAULT_DATA_DIR
  return {
    port: integer('PORT', vars.PORT, DEFAULT_PORT, 0, 65535),
    host: present(vars.HOST) ?? DEFAULT_HOST,
    trustProxy: flag('TRUST_PROXY', vars.TRUST_PROXY),
    databasePath: present(vars.DATABASE_PATH) ?? joinPath(dataDir, 'git-forge.sqlite'),
    storage: storageConfig(vars, dataDir),
    schedule: schedule(vars.SCHEDULE),
    jobConcurrency: integer('JOB_CONCURRENCY', vars.JOB_CONCURRENCY, DEFAULT_JOB_CONCURRENCY, 1, 64),
    lfsPublishDir: present(vars.LFS_PUBLISH_DIR) ?? null,
  }
}
