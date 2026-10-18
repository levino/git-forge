import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { compactRepository, ObjectDatabase } from '@git-forge/core'
import { FsStorage } from '@git-forge/node'
import { handleRequest } from '../src/app.ts'
import { generateHistory, git, gitEnv, tempDir } from '../test/e2e/history.ts'

type Sample = { label: string; cpuMs: number; wallMs: number; requests: number; maxRequestCpuMs: number; peakMemoryMiB: number }

const MiB = 1024 * 1024
const token = 'bench'
const root = mkdtempSync(join(tmpdir(), 'git-forge-bench-'))
const storage = new FsStorage(join(root, 'bucket'))
const config = { storage, adminToken: token, publicRead: true, compactMaxBytes: 0 }
let current: Sample | null = null

const server = createServer((incoming, outgoing) => {
  const started = process.cpuUsage()
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value)
  const method = incoming.method ?? 'GET'
  const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' }),
  } as RequestInit)
  void (async () => {
    const response = await handleRequest(request, config)
    outgoing.statusCode = response.status
    response.headers.forEach((value, key) => outgoing.setHeader(key, value))
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!outgoing.write(value)) await new Promise<void>((resolve) => outgoing.once('drain', () => resolve()))
      }
    }
    outgoing.end()
    const used = process.cpuUsage(started)
    const cpuMs = (used.user + used.system) / 1000
    if (current) {
      current.cpuMs += cpuMs
      current.requests++
      current.maxRequestCpuMs = Math.max(current.maxRequestCpuMs, cpuMs)
    }
  })()
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

const memory = () => {
  const usage = process.memoryUsage()
  return usage.heapUsed + usage.arrayBuffers
}

const measure = async (label: string, action: () => Promise<unknown>): Promise<Sample> => {
  globalThis.gc?.()
  const baseline = memory()
  let peak = baseline
  const sampler = setInterval(() => (peak = Math.max(peak, memory())), 5)
  current = { label, cpuMs: 0, wallMs: 0, requests: 0, maxRequestCpuMs: 0, peakMemoryMiB: 0 }
  const started = performance.now()
  const cpuStarted = process.cpuUsage()
  await action()
  clearInterval(sampler)
  current.wallMs = performance.now() - started
  if (current.requests === 0) {
    const used = process.cpuUsage(cpuStarted)
    current.cpuMs = (used.user + used.system) / 1000
    current.maxRequestCpuMs = current.cpuMs
  }
  current.peakMemoryMiB = (peak - baseline) / MiB
  const sample = current
  current = null
  console.error(JSON.stringify(sample))
  return sample
}

const generateLarge = async (dir: string, commits: number, blobs: number, blobBytes: number): Promise<void> => {
  const child = spawn('git', ['fast-import', '--quiet'], { cwd: dir, env: { ...process.env, ...gitEnv }, stdio: ['pipe', 'inherit', 'inherit'] })
  const write = (chunk: Buffer | string) =>
    new Promise<void>((resolve) => (child.stdin.write(chunk) ? resolve() : child.stdin.once('drain', () => resolve())))
  const every = Math.max(1, Math.floor(commits / blobs))
  for (let commit = 0; commit < commits; commit++) {
    await write(`commit refs/heads/main\ncommitter Bench <bench@example.org> ${1_767_225_600 + commit * 60} +0000\n`)
    const message = Buffer.from(`commit ${commit}\n`)
    await write(`data ${message.length}\n`)
    await write(message)
    const text = Buffer.from(Array.from({ length: 400 }, (_, line) => `module ${commit % 13} line ${line} ${line % 17 === commit % 17 ? commit : ''}`).join('\n'))
    await write(`M 100644 inline src/module-${commit % 13}.txt\ndata ${text.length}\n`)
    await write(text)
    await write('\n')
    if (commit % every === 0) {
      await write(`M 100644 inline assets/blob-${commit}.bin\ndata ${blobBytes}\n`)
      await write(randomBytes(blobBytes))
      await write('\n')
    }
    await write('\n')
  }
  child.stdin.end()
  await new Promise<void>((resolve, reject) => child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`)))))
}

type Scenario = {
  readonly name: string
  readonly prepare: (dir: string) => Promise<void>
}

const scenarios: Scenario[] = [
  { name: 'small', prepare: async (dir) => generateHistory(dir, { commits: 120, files: 40, binaryBytes: 48 * 1024, seed: 7 }) },
  { name: 'medium', prepare: async (dir) => generateHistory(dir, { commits: 500, files: 200, binaryBytes: 256 * 1024, seed: 7 }) },
  { name: 'large', prepare: async (dir) => generateHistory(dir, { commits: 600, files: 300, binaryBytes: 512 * 1024, seed: 7 }) },
  { name: 'xl', prepare: (dir) => generateLarge(dir, 400, 40, 5 * MiB) },
  { name: 'xxl', prepare: (dir) => generateLarge(dir, 1000, 100, Math.round(10.24 * MiB)) },
]
const selected = process.argv.slice(2)

const samples: Sample[] = []
for (const scenario of scenarios.filter((entry) => selected.length === 0 || selected.includes(entry.name))) {
  await handleRequest(
    new Request(`${base}/api/admin/repos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ owner: 'bench', name: scenario.name }),
    }),
    config,
  )
  const source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  await scenario.prepare(source)
  await git(source, ['gc', '-q'])
  const packBytes = Number(/size-pack: (\d+)/.exec(await git(source, ['count-objects', '-v']))?.[1] ?? 0) * 1024
  const objects = (await git(source, ['rev-list', '--objects', '--all'])).trim().split('\n').length
  const commits = (await git(source, ['rev-list', '--count', 'HEAD'])).trim()
  const remote = `${base}/bench/${scenario.name}.git`
  const pushUrl = remote.replace('http://', `http://git:${token}@`)
  const tag = `${scenario.name} (${commits} commits, ${objects} objects, ${(packBytes / MiB).toFixed(1)} MiB pack)`
  const clone = async (args: readonly string[]) => {
    const dir = tempDir()
    await git(dir, [...args, 'clone', '-q', remote, 'out'])
    return dir
  }
  samples.push(await measure(`push ${tag}`, () => git(source, ['push', '-q', pushUrl, 'main'])))
  let dir = ''
  samples.push(await measure(`clone v2 ${scenario.name}`, async () => (dir = await clone([]))))
  rmSync(dir, { recursive: true, force: true })
  samples.push(await measure(`clone v2 with packfile-uris ${scenario.name}`, async () => (dir = await clone(['-c', 'fetch.uriProtocols=http']))))
  rmSync(dir, { recursive: true, force: true })
  samples.push(await measure(`clone dumb ${scenario.name}`, async () => (dir = await clone(['-c', 'protocol.version=0']))))
  const behind = dir
  generateHistory(source, { commits: 20, files: 40, binaryBytes: 16 * 1024, seed: 11, from: 'refs/heads/main^0' })
  samples.push(await measure(`push incremental ${scenario.name} (20 commits)`, () => git(source, ['push', '-q', pushUrl, 'main'])))
  samples.push(await measure(`fetch incremental ${scenario.name}`, () => git(`${behind}/out`, ['pull', '-q', '--ff-only'])))
  rmSync(behind, { recursive: true, force: true })
  samples.push(await measure(`clone v2 ${scenario.name} (2 packs)`, async () => (dir = await clone([]))))
  rmSync(dir, { recursive: true, force: true })
  const repo = { owner: 'bench', name: scenario.name }
  samples.push(await measure(`compact ${scenario.name} (2 packs into 1)`, () => compactRepository(storage, repo, { all: true })))
  const odb = new ObjectDatabase(storage, repo)
  if ((await odb.packNames()).length !== 1) throw new Error('compaction did not converge')
  rmSync(source, { recursive: true, force: true })
}
server.close()
rmSync(root, { recursive: true, force: true })

console.log('| operation | requests | CPU total (ms) | CPU max per request (ms) | wall (ms) | peak JS memory (MiB) |')
console.log('|---|---|---|---|---|---|')
for (const sample of samples) {
  console.log(`| ${sample.label} | ${sample.requests} | ${Math.round(sample.cpuMs)} | ${Math.round(sample.maxRequestCpuMs)} | ${Math.round(sample.wallMs)} | ${Math.round(sample.peakMemoryMiB)} |`)
}
console.log(`peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB, node ${process.version}`)
