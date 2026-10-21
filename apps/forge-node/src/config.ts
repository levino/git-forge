import type { S3StorageConfig } from '@git-forge/s3'
import type { SmtpSecurity } from '@git-forge/smtp'
import { ConfigurationError, type EmailSettings, type ForgeVars, parseEmailSettings } from 'forge-worker/config'
import { type CronSchedule, CronError, parseCron } from './cron.ts'

export type NodeVars = ForgeVars & {
  readonly PORT?: string
  readonly HOST?: string
  readonly TRUST_PROXY?: string
  readonly DATA_DIR?: string
  readonly DATABASE?: string
  readonly DATABASE_PATH?: string
  readonly LIBSQL_URL?: string
  readonly LIBSQL_AUTH_TOKEN?: string
  readonly CONDITIONAL_WRITES?: string
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
  readonly JOB_POLL_SECONDS?: string
  readonly SMTP_HOST?: string
  readonly SMTP_PORT?: string
  readonly SMTP_SECURITY?: string
  readonly SMTP_USERNAME?: string
  readonly SMTP_PASSWORD?: string
  readonly SMTP_HELO?: string
  readonly LFS_PUBLISH_DIR?: string
  readonly BACKUP_STORAGE?: string
  readonly BACKUP_STORAGE_DIR?: string
  readonly BACKUP_S3_ENDPOINT?: string
  readonly BACKUP_S3_REGION?: string
  readonly BACKUP_S3_BUCKET?: string
  readonly BACKUP_S3_ACCESS_KEY_ID?: string
  readonly BACKUP_S3_SECRET_ACCESS_KEY?: string
  readonly BACKUP_S3_PREFIX?: string
  readonly BACKUP_S3_FORCE_PATH_STYLE?: string
}

export type SmtpSettings = {
  readonly provider: 'smtp'
  readonly from: string
  readonly host: string
  readonly port?: number
  readonly security: SmtpSecurity
  readonly username?: string
  readonly password?: string
  readonly helo?: string
}

export type NodeEmailSettings = Exclude<EmailSettings, { readonly provider: 'cloudflare' }> | SmtpSettings

export type StorageConfig = { readonly kind: 'fs'; readonly dir: string } | { readonly kind: 's3'; readonly config: S3StorageConfig }

export type DatabaseConfig = { readonly kind: 'sqlite'; readonly path: string } | { readonly kind: 'libsql'; readonly url: string; readonly authToken?: string }

export type ConditionalWrites = 'storage' | 'database'

export type NodeConfig = {
  readonly port: number
  readonly host: string
  readonly trustProxy: boolean
  readonly database: DatabaseConfig
  readonly storage: StorageConfig
  readonly conditionalWrites: ConditionalWrites
  readonly schedule: CronSchedule
  readonly jobConcurrency: number
  readonly jobPollMs: number
  readonly email: NodeEmailSettings | undefined
  readonly lfsPublishDir: string | null
  readonly backup: StorageConfig | null
}

export const DEFAULT_PORT = 8080

export const DEFAULT_HOST = '0.0.0.0'

export const DEFAULT_DATA_DIR = './data'

export const DEFAULT_SCHEDULE = '17 3 * * *'

export const DEFAULT_JOB_CONCURRENCY = 2

export const DEFAULT_JOB_POLL_SECONDS = 30

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

const storageConfig = (vars: NodeVars, scope: '' | 'BACKUP_', defaultDir: string | null): StorageConfig | null => {
  const value = (name: string) => present((vars as Record<string, string | undefined>)[`${scope}${name}`])
  const required = (name: string): string => {
    const found = value(name)
    if (found === undefined) throw new ConfigurationError(`${scope}${name} is required with ${scope}STORAGE=s3`)
    return found
  }
  const kind = value('STORAGE') ?? (defaultDir === null ? undefined : 'fs')
  if (kind === undefined) return null
  if (kind === 'fs') {
    const dir = value('STORAGE_DIR') ?? defaultDir
    if (dir === null) throw new ConfigurationError(`${scope}STORAGE_DIR is required with ${scope}STORAGE=fs`)
    return { kind, dir }
  }
  if (kind !== 's3') throw new ConfigurationError(`${scope}STORAGE must be fs or s3`)
  const endpoint = required('S3_ENDPOINT')
  try {
    new URL(endpoint)
  } catch {
    throw new ConfigurationError(`${scope}S3_ENDPOINT must be a URL`)
  }
  const prefix = value('S3_PREFIX')
  return {
    kind,
    config: {
      endpoint,
      region: value('S3_REGION') ?? 'us-east-1',
      bucket: required('S3_BUCKET'),
      accessKeyId: required('S3_ACCESS_KEY_ID'),
      secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
      forcePathStyle: flag(`${scope}S3_FORCE_PATH_STYLE`, value('S3_FORCE_PATH_STYLE')),
      ...(prefix ? { prefix } : {}),
    },
  }
}

const databaseConfig = (vars: NodeVars, dataDir: string): DatabaseConfig => {
  const kind = present(vars.DATABASE) ?? 'sqlite'
  if (kind === 'sqlite') return { kind, path: present(vars.DATABASE_PATH) ?? joinPath(dataDir, 'git-forge.sqlite') }
  if (kind !== 'libsql') throw new ConfigurationError('DATABASE must be sqlite or libsql')
  const url = present(vars.LIBSQL_URL)
  if (!url) throw new ConfigurationError('LIBSQL_URL is required with DATABASE=libsql')
  if (!/^(libsql|https?|wss?):\/\/[^/]/.test(url)) throw new ConfigurationError('LIBSQL_URL must be a libsql://, https:// or http:// URL')
  const authToken = present(vars.LIBSQL_AUTH_TOKEN)
  return { kind, url, ...(authToken ? { authToken } : {}) }
}

const conditionalWrites = (value: string | undefined): ConditionalWrites => {
  const text = present(value) ?? 'storage'
  if (text !== 'storage' && text !== 'database') throw new ConfigurationError('CONDITIONAL_WRITES must be storage or database')
  return text
}

const schedule = (value: string | undefined): CronSchedule => {
  try {
    return parseCron(present(value) ?? DEFAULT_SCHEDULE)
  } catch (error) {
    if (error instanceof CronError) throw new ConfigurationError(`SCHEDULE: ${error.message}`)
    throw error
  }
}

const SMTP_SECURITY: readonly SmtpSecurity[] = ['starttls', 'tls', 'none']

const smtpSettings = (vars: NodeVars, from: string): SmtpSettings => {
  const host = present(vars.SMTP_HOST)
  if (!host) throw new ConfigurationError('SMTP_HOST is required with EMAIL_PROVIDER=smtp')
  const security = (present(vars.SMTP_SECURITY) ?? 'starttls') as SmtpSecurity
  if (!SMTP_SECURITY.includes(security)) throw new ConfigurationError('SMTP_SECURITY must be starttls, tls or none')
  const username = present(vars.SMTP_USERNAME)
  const password = vars.SMTP_PASSWORD === undefined || vars.SMTP_PASSWORD === '' ? undefined : vars.SMTP_PASSWORD
  if ((username === undefined) !== (password === undefined)) throw new ConfigurationError('SMTP_USERNAME and SMTP_PASSWORD go together')
  if (username !== undefined && security === 'none') throw new ConfigurationError('SMTP_USERNAME needs SMTP_SECURITY=starttls or tls')
  const port = present(vars.SMTP_PORT) === undefined ? undefined : integer('SMTP_PORT', vars.SMTP_PORT, 0, 1, 65535)
  const helo = present(vars.SMTP_HELO)
  return {
    provider: 'smtp',
    from,
    host,
    security,
    ...(port !== undefined ? { port } : {}),
    ...(username !== undefined && password !== undefined ? { username, password } : {}),
    ...(helo ? { helo } : {}),
  }
}

const emailSettings = (vars: NodeVars): NodeEmailSettings | undefined => {
  if (present(vars.EMAIL_PROVIDER) !== 'smtp') {
    try {
      const settings = parseEmailSettings(vars)
      return settings?.provider === 'cloudflare' ? undefined : settings
    } catch (error) {
      if (error instanceof ConfigurationError && /EMAIL_PROVIDER (must be|=cloudflare)/.test(error.message)) throw new ConfigurationError('EMAIL_PROVIDER must be none, console, ses or smtp')
      throw error
    }
  }
  const from = present(vars.EMAIL_FROM)
  if (!from) throw new ConfigurationError('EMAIL_FROM is required when EMAIL_PROVIDER is set')
  return smtpSettings(vars, from)
}

export const parseNodeConfig = (vars: NodeVars): NodeConfig => {
  const dataDir = present(vars.DATA_DIR) ?? DEFAULT_DATA_DIR
  return {
    port: integer('PORT', vars.PORT, DEFAULT_PORT, 0, 65535),
    host: present(vars.HOST) ?? DEFAULT_HOST,
    trustProxy: flag('TRUST_PROXY', vars.TRUST_PROXY),
    database: databaseConfig(vars, dataDir),
    storage: storageConfig(vars, '', joinPath(dataDir, 'objects'))!,
    conditionalWrites: conditionalWrites(vars.CONDITIONAL_WRITES),
    schedule: schedule(vars.SCHEDULE),
    jobConcurrency: integer('JOB_CONCURRENCY', vars.JOB_CONCURRENCY, DEFAULT_JOB_CONCURRENCY, 1, 64),
    jobPollMs: integer('JOB_POLL_SECONDS', vars.JOB_POLL_SECONDS, DEFAULT_JOB_POLL_SECONDS, 1, 3600) * 1000,
    email: emailSettings(vars),
    lfsPublishDir: present(vars.LFS_PUBLISH_DIR) ?? null,
    backup: storageConfig(vars, 'BACKUP_', null),
  }
}
