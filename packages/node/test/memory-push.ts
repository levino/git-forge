import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRepository, handleGitRequest, ObjectDatabase } from '@git-forge/core'
import { gitEnv, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { startServer } from '@git-forge/core/test/http-server.ts'
import { FsStorage } from '../src/fs-storage.ts'

const [packMiB = '64', budgetMiB = '4', chunkMiB = '1'] = process.argv.slice(2)
const MiB = 1024 * 1024
const run = promisify(execFile)
const git = async (cwd: string, args: readonly string[]) =>
  (await run('git', args, { cwd, env: { ...process.env, ...gitEnv }, maxBuffer: 64 * MiB })).stdout

const root = mkdtempSync(join(tmpdir(), 'git-forge-memory-'))
const storage = new FsStorage(join(root, 'bucket'))
const repo = { owner: 'mem', name: 'big' }
await createRepository(storage, repo)
const options = { storage, receive: { pack: { memoryBudget: Number(budgetMiB) * MiB, chunkSize: Number(chunkMiB) * MiB } } }
const server = await startServer(async (request) => (await handleGitRequest(request, options)) ?? new Response('not found', { status: 404 }))

const source = join(root, 'source')
await git(root, ['init', '-q', '-b', 'main', source])
const files = Math.ceil(Number(packMiB) / 2)
for (let i = 0; i < files; i++) writeFile(source, `blobs/${i}.bin`, randomBytes(MiB))
for (let i = 0; i < 200; i++) writeFile(source, `text/${i}.txt`, Array.from({ length: 300 }, (_, n) => `line ${n} of ${i}`).join('\n'))
await git(source, ['add', '-A'])
await git(source, ['commit', '-q', '-m', 'first'])
for (let i = 0; i < files; i++) writeFile(source, `blobs/${i}.bin`, Buffer.concat([randomBytes(64 * 1024), randomBytes(MiB)]))
for (let i = 0; i < 200; i += 3) writeFile(source, `text/${i}.txt`, Array.from({ length: 300 }, (_, n) => `line ${n} of ${i} changed`).join('\n'))
await git(source, ['add', '-A'])
await git(source, ['commit', '-q', '-m', 'second'])

const used = () => {
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.arrayBuffers
}

const measure = async (action: () => Promise<unknown>): Promise<number> => {
  globalThis.gc?.()
  const baseline = used()
  let peak = baseline
  const sampler = setInterval(() => (peak = Math.max(peak, used())), 2)
  await action()
  clearInterval(sampler)
  return (peak - baseline) / MiB
}

const remote = `${server.url}/mem/big.git`
const pushPeakMiB = await measure(() => git(source, ['push', '-q', remote, 'main']))
const odb = new ObjectDatabase(storage, repo)
const [pack] = await odb.packs()
const packBytes = pack ? await odb.packSize(pack) : 0
const clonePeakMiB = await measure(() => git(root, ['clone', '-q', remote, join(root, 'clone')]))
const fsck = await git(join(root, 'clone'), ['fsck', '--full'])
await server.close()
rmSync(root, { recursive: true, force: true })
console.log(JSON.stringify({ packMiB: packBytes / MiB, pushPeakMiB, clonePeakMiB, fsck, budgetMiB: Number(budgetMiB) }))
