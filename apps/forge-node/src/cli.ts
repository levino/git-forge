import { generateSigningKey } from '@git-forge/accounts'
import { serve } from '@git-forge/node'
import { ACTIONS_CRON, ConfigurationError, generateEs256Key, importEs256Key } from 'forge-worker/config'
import { parseCron } from './cron.ts'
import { createInstance, jsonLog, type Log, migrate, restore, restoreSqlFrom, verify } from './instance.ts'
import { startScheduler } from './scheduler.ts'

declare const GIT_FORGE_VERSION: string | undefined

export const VERSION = typeof GIT_FORGE_VERSION === 'string' ? GIT_FORGE_VERSION : 'dev'

const USAGE = `usage: git-forge-node <command>

commands:
  serve          run the forge: HTTP server, job runner and mirror schedule (default)
  migrate        apply pending database migrations and exit
  instance-key   print a new Ed25519 instance key (private JWK) for INSTANCE_KEY
  oidc-key       print a new P-256 key (private JWK) for ACTIONS_OIDC_KEY
  restore [id]   restore the latest (or the given) backup from BACKUP_STORAGE into an empty DATABASE_PATH and STORAGE
  restore-sql [id]
                 print the database dump of a backup as SQL (for wrangler d1 execute)
  backup-verify [n]
                 re-hash n (default 20) random backed-up objects in BACKUP_STORAGE
  version        print the version

Configuration comes from environment variables; see the README.`

export type Env = Record<string, string | undefined>

const runServe = async (env: Env, log: Log): Promise<number> => {
  const instance = await createInstance(env, { log })
  const { config, forge } = instance
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
  log({
    event: 'listening',
    version: VERSION,
    url: server.url,
    host: config.host,
    port: (server.server.address() as { port: number }).port,
    storage: config.storage.kind,
    database: config.database.kind === 'sqlite' ? config.database.path : config.database.url,
    conditionalWrites: config.conditionalWrites,
    schedule: config.schedule.source,
    nextScheduledRun: scheduler.next()?.toISOString(),
  })
  await new Promise<void>((resolve) => {
    const stop = (signal: string) => {
      log({ event: 'stopping', signal })
      resolve()
    }
    process.once('SIGTERM', () => stop('SIGTERM'))
    process.once('SIGINT', () => stop('SIGINT'))
  })
  await Promise.all([server.close(), scheduler.stop(), actions.stop()])
  await instance.close()
  log({ event: 'stopped' })
  return 0
}

export const main = async (args: readonly string[], env: Env = process.env, log: Log = jsonLog): Promise<number> => {
  const [command = 'serve', ...rest] = args
  if (rest.length > (['restore', 'restore-sql', 'backup-verify'].includes(command) ? 1 : 0) || command === 'help' || command === '-h' || command === '--help') {
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
      case 'restore':
        log({ event: 'restored', ...(await restore(env, rest[0])) })
        return 0
      case 'restore-sql':
        for await (const chunk of await restoreSqlFrom(env, rest[0])) process.stdout.write(chunk)
        return 0
      case 'backup-verify': {
        const result = await verify(env, Number(rest[0] ?? 20))
        log({ event: 'backup-verified', ...result })
        return result.failures.length === 0 ? 0 : 1
      }
      case 'instance-key': {
        const { key, privateJwk } = await generateSigningKey()
        process.stderr.write(`key id (JWK thumbprint, usable as pinnedThumbprint): ${key.kid}\n`)
        process.stdout.write(`${JSON.stringify(privateJwk)}\n`)
        return 0
      }
      case 'oidc-key': {
        const privateJwk = await generateEs256Key()
        process.stderr.write(`key id (JWK thumbprint): ${(await importEs256Key(privateJwk)).kid}\n`)
        process.stdout.write(`${JSON.stringify(privateJwk)}\n`)
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
