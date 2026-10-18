import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import {
  bareRepositoryFiles,
  checkBackupStructure,
  findSnapshot,
  generateRecoveryKey,
  parseRecoveryPrivateKey,
  replicateBackup,
  restoreSnapshot,
  runKeys,
  summarizeSnapshots,
} from '@git-forge/backup'
import type { Storage } from '@git-forge/core'
import { FsStorage } from '@git-forge/node'
import { S3Storage } from '@git-forge/s3'
import { BACKUP_USAGE } from './backup-usage.ts'

export type Io = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export const openLocation = (location: string, env: Io['env']): Storage => {
  if (!location.startsWith('s3://')) return new FsStorage(resolve(location))
  const [bucket, ...rest] = location.slice('s3://'.length).split('/')
  const endpoint = env.S3_ENDPOINT
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey) throw new Error('s3:// locations need a bucket, S3_ENDPOINT, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY')
  const prefix = rest.filter(Boolean).join('/')
  return new S3Storage({
    endpoint,
    region: env.S3_REGION ?? 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    ...(prefix ? { prefix: `${prefix}/` } : {}),
  })
}

type Options = { readonly flags: Map<string, string>; readonly positional: string[] }

const parse = (args: readonly string[]): Options => {
  const flags = new Map<string, string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined]
      const value = inline ?? args[++i]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      flags.set(name, value)
    } else positional.push(arg)
  }
  return { flags, positional }
}

const need = (options: Options, name: string): string => {
  const value = options.flags.get(name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

const repositoryName = (text: string | undefined) => {
  const match = /^([^/]+)\/([^/]+)$/.exec(text ?? '')
  if (!match) throw new Error('expected <owner>/<name>')
  return { owner: match[1] as string, name: match[2] as string }
}

const writeStream = async (path: string, body: ReadableStream<Uint8Array>) => {
  mkdirSync(dirname(path), { recursive: true })
  await body.pipeTo(Writable.toWeb(createWriteStream(path)) as WritableStream<Uint8Array>)
}

const writeBytes = (path: string, bytes: Uint8Array | string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

export const backupCommand = async (args: readonly string[], io: Io): Promise<number> => {
  const [action, ...rest] = args
  const options = parse(rest)
  switch (action) {
    case 'keygen': {
      const file = options.positional[0]
      if (!file) throw new Error('expected the file for the private key')
      if (existsSync(file)) throw new Error(`${file} exists`)
      const { privateKey, publicKey, id } = await generateRecoveryKey()
      writeFileSync(file, `${JSON.stringify(privateKey)}\n`, { mode: 0o600, flag: 'wx' })
      io.err(`recovery key ${id} written to ${file}; keep it offline. Public key for BACKUP_RECOVERY_KEY:\n`)
      io.out(`${JSON.stringify(publicKey)}\n`)
      return 0
    }
    case 'list': {
      const backup = openLocation(need(options, 'from'), io.env)
      const keys = runKeys(backup, parseRecoveryPrivateKey(readFileSync(need(options, 'key'), 'utf8')))
      for (const summary of await summarizeSnapshots(backup, keys)) {
        io.out(`${summary.key}\t${summary.created}\t${summary.repository}\trefs=${summary.refs} packs=${summary.packs} lfs=${summary.lfs}${summary.data ? ' data' : ''}\n`)
      }
      return 0
    }
    case 'restore': {
      const backup = openLocation(need(options, 'from'), io.env)
      const keys = runKeys(backup, parseRecoveryPrivateKey(readFileSync(need(options, 'key'), 'utf8')))
      const repository = repositoryName(options.positional[0])
      const dir = options.positional[1]
      if (!dir) throw new Error('expected the directory to restore into')
      if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${dir} is not empty`)
      const { key, snapshot } = await findSnapshot(backup, keys, repository, options.flags.get('snapshot'))
      mkdirSync(join(dir, 'refs', 'heads'), { recursive: true })
      mkdirSync(join(dir, 'refs', 'tags'), { recursive: true })
      const result = await restoreSnapshot(backup, keys, snapshot.repository, {
        index: async (name, bytes) => writeBytes(join(dir, 'objects', 'pack', name), bytes),
        pack: (name, _size, body) => writeStream(join(dir, 'objects', 'pack', name), body),
        lfs: (oid, _size, body) => writeStream(join(dir, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid), body),
        finish: async (refs, packs) => {
          for (const [path, text] of Object.entries(bareRepositoryFiles(refs, packs))) writeBytes(join(dir, path), text)
        },
      })
      if (result.data) writeBytes(join(dir, 'git-forge-data.json'), result.data)
      io.err(`restored ${repository.owner}/${repository.name} from ${key} (${snapshot.created}): ${result.packs} packs, ${result.lfs} LFS objects${result.data ? ', data export' : ''}\n`)
      return 0
    }
    case 'check': {
      const report = await checkBackupStructure(openLocation(need(options, 'from'), io.env))
      io.out(`${report.objects} objects, ${report.snapshots} snapshots, ${report.runs} runs, ${report.bytes} bytes\n`)
      for (const problem of report.problems) io.out(`${problem.key}: ${problem.problem}\n`)
      return report.problems.length === 0 ? 0 : 1
    }
    case 'copy': {
      const result = await replicateBackup(openLocation(need(options, 'from'), io.env), openLocation(need(options, 'to'), io.env))
      io.out(`copied ${result.copied} objects (${result.copiedBytes} bytes), ${result.present} already present\n`)
      return 0
    }
    default:
      io.err(`${BACKUP_USAGE}\n`)
      return 1
  }
}
