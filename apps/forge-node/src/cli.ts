import { readFile } from 'node:fs/promises'
import { generateSigningKey } from '@git-forge/accounts'
import { generateRecoveryKey } from '@git-forge/backup'
import { serve } from '@git-forge/node'
import { ACTIONS_CRON, ConfigurationError } from 'forge-worker/config'
import { parseCron } from './cron.ts'
import { openBackupStorage, parseBackupConfig, restoreIntoInstance, runBackup } from './backup.ts'
import { createInstance, jsonLog, type Log, migrate, type NodeInstance } from './instance.ts'
import { startScheduler } from './scheduler.ts'

declare const GIT_FORGE_VERSION: string | undefined

export const VERSION = typeof GIT_FORGE_VERSION === 'string' ? GIT_FORGE_VERSION : 'dev'

const USAGE = `usage: git-forge-node <command>

commands:
  serve          run the forge: HTTP server, job runner and mirror schedule (default)
  migrate        apply pending database migrations and exit
  instance-key   print a new Ed25519 instance key (private JWK) for INSTANCE_KEY
  backup         push an encrypted backup of the selected repositories now
  restore <owner>/<name> --key <file> [--snapshot <key>] [--as <owner>/<name>]
                 rebuild a repository (Git, LFS, issues, pull requests) from the backup
  recovery-key   print a new X25519 recovery key (private JWK); the public key
                 for BACKUP_RECOVERY_KEY goes to stderr
  version        print the version

Configuration comes from environment variables; see the README.`

export type Env = Record<string, string | undefined>

const backupNow = async (instance: NodeInstance, env: Env, log: Log): Promise<number> => {
  const config = parseBackupConfig(env)
  if (!config) throw new ConfigurationError('BACKUP_RECOVERY_KEY is not set')
  const results = await runBackup({ storage: instance.storage, db: instance.db, config, ...(env.PUBLIC_URL ? { instance: env.PUBLIC_URL } : {}) })
  for (const result of results) log({ event: 'backup', repo: `${result.repository.owner}/${result.repository.name}`, ...result, repository: undefined })
  return results.length
}

const parseFlags = (args: readonly string[]) => {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const value = args[++i]
    if (value === undefined) throw new ConfigurationError(`${arg} needs a value`)
    flags.set(arg.slice(2), value)
  }
  return { flags, positional }
}

const repositoryArgument = (text: string | undefined) => {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(text ?? '')
  if (!match) throw new ConfigurationError('expected <owner>/<name>')
  return { owner: match[1] as string, name: match[2] as string }
}

const runRestore = async (args: readonly string[], env: Env, log: Log): Promise<number> => {
  const { flags, positional } = parseFlags(args)
  const repository = repositoryArgument(positional[0])
  const keyFile = flags.get('key')
  if (!keyFile) throw new ConfigurationError('restore needs --key <file> with the private recovery key')
  const config = parseBackupConfig(env)
  if (!config) throw new ConfigurationError('BACKUP_RECOVERY_KEY and the BACKUP_* location are needed to find the backup')
  const instance = await createInstance(env, { log })
  try {
    const snapshot = flags.get('snapshot')
    const outcome = await restoreIntoInstance({
      storage: instance.storage,
      db: instance.db,
      backup: await openBackupStorage(config.target),
      repository,
      as: flags.has('as') ? repositoryArgument(flags.get('as')) : repository,
      privateKey: await readFile(keyFile, 'utf8'),
      ...(snapshot ? { snapshot } : {}),
    })
    log({ event: 'restored', repo: `${repository.owner}/${repository.name}`, ...outcome })
    return 0
  } finally {
    await instance.close()
  }
}

const runServe = async (env: Env, log: Log): Promise<number> => {
  const instance = await createInstance(env, { log })
  const { config, forge } = instance
  const backup = parseBackupConfig(env)
  const server = await serve(forge.fetch, {
    port: config.port,
    host: config.host,
    trustProxy: config.trustProxy,
    onError: (error, request) => log({ event: 'error', method: request?.method, url: request?.url, error: error instanceof Error ? error.stack : String(error) }),
  })
  const scheduler = startScheduler({
    schedule: config.schedule,
    task: async (at) => {
      const runs = await forge.scheduled(at)
      log({ event: 'scheduled', cron: config.schedule.source, at: at.toISOString(), task: 'mirror-sync', runs })
    },
    onError: (error, at) => log({ event: 'scheduled', cron: config.schedule.source, at: at.toISOString(), error: error instanceof Error ? error.message : String(error) }),
  })
  const actions = startScheduler({
    schedule: parseCron(ACTIONS_CRON),
    task: async (at) => {
      const tick = await forge.actionsTick()
      if (tick && (tick.scheduled.length > 0 || Object.values(tick.reaped).some((count) => count > 0))) {
        log({ event: 'scheduled', cron: ACTIONS_CRON, at: at.toISOString(), task: 'actions', scheduled: tick.scheduled.length, reaped: tick.reaped })
      }
    },
    onError: (error, at) => log({ event: 'scheduled', cron: ACTIONS_CRON, at: at.toISOString(), task: 'actions', error: error instanceof Error ? error.message : String(error) }),
  })
  const backups = backup?.schedule
    ? startScheduler({
        schedule: backup.schedule,
        task: async (at) => {
          const count = await backupNow(instance, env, log)
          log({ event: 'scheduled', cron: backup.schedule!.source, at: at.toISOString(), task: 'backup', repositories: count })
        },
        onError: (error, at) => log({ event: 'scheduled', cron: backup.schedule!.source, at: at.toISOString(), task: 'backup', error: error instanceof Error ? error.message : String(error) }),
      })
    : null
  log({
    event: 'listening',
    version: VERSION,
    url: server.url,
    host: config.host,
    port: (server.server.address() as { port: number }).port,
    storage: config.storage.kind,
    database: config.databasePath,
    schedule: config.schedule.source,
    nextScheduledRun: scheduler.next()?.toISOString(),
    ...(backups ? { nextBackup: backups.next()?.toISOString() } : {}),
  })
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log({ event: 'stopping', signal })
      resolve()
    }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
  })
  await Promise.all([server.close(), scheduler.stop(), actions.stop(), backups?.stop()])
  await instance.close()
  log({ event: 'stopped' })
  return 0
}

export const main = async (args: readonly string[], env: Env = process.env, log: Log = jsonLog): Promise<number> => {
  const [command = 'serve', ...rest] = args
  if ((rest.length > 0 && command !== 'restore') || command === 'help' || command === '-h' || command === '--help') {
    process.stdout.write(`${USAGE}\n`)
    return command === 'help' || command === '-h' || command === '--help' ? 0 : 1
  }
  try {
    switch (command) {
      case 'serve':
        return await runServe(env, log)
      case 'migrate': {
        const applied = await migrate(env)
        log({ event: 'migrated', applied })
        return 0
      }
      case 'instance-key': {
        const { key, privateJwk } = await generateSigningKey()
        process.stderr.write(`key id (JWK thumbprint, usable as pinnedThumbprint): ${key.kid}\n`)
        process.stdout.write(`${JSON.stringify(privateJwk)}\n`)
        return 0
      }
      case 'backup': {
        const instance = await createInstance(env, { log })
        try {
          await backupNow(instance, env, log)
        } finally {
          await instance.close()
        }
        return 0
      }
      case 'restore':
        return await runRestore(rest, env, log)
      case 'recovery-key': {
        const { privateKey, publicKey, id } = await generateRecoveryKey()
        process.stderr.write(`recovery key ${id}; keep the private key offline. BACKUP_RECOVERY_KEY=${JSON.stringify(publicKey)}\n`)
        process.stdout.write(`${JSON.stringify(privateKey)}\n`)
        return 0
      }
      case 'version':
      case '--version':
        process.stdout.write(`git-forge-node ${VERSION}\n`)
        return 0
      default:
        process.stderr.write(`unknown command ${command}\n${USAGE}\n`)
        return 1
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      process.stderr.write(`git-forge-node: ${error.message}\n`)
      return 2
    }
    throw error
  }
}
