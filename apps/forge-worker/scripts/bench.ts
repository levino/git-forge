import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { generateHistory, git, tempDir } from '../test/e2e/history.ts'
import { bootstrap, call, nodeForge } from '../test/support/node-forge.ts'

type Sample = { label: string; cpuMs: number; wallMs: number; requests: number; maxRequestCpuMs: number; peakMemoryMiB: number }

const forge = await nodeForge({ maxPushBytes: 64 * 1024 * 1024 })
let current: Sample | null = null

const server = createServer((incoming, outgoing) => {
  const started = process.cpuUsage()
  const headers = new Headers()
  for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value)
  const method = incoming.method ?? 'GET'
  const request = new Request(`http://localhost${incoming.url}`, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: Readable.toWeb(incoming) as ReadableStream, duplex: 'half' }),
  } as RequestInit)
  void (async () => {
    const response = await forge.fetch(request)
    const body = new Uint8Array(await response.arrayBuffer())
    const used = process.cpuUsage(started)
    const cpuMs = (used.user + used.system) / 1000
    if (current) {
      current.cpuMs += cpuMs
      current.requests++
      current.maxRequestCpuMs = Math.max(current.maxRequestCpuMs, cpuMs)
    }
    outgoing.statusCode = response.status
    response.headers.forEach((value, key) => outgoing.setHeader(key, value))
    outgoing.end(body)
  })()
})
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
const token = await bootstrap(forge, base, 'bench')

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
  await action()
  clearInterval(sampler)
  current.wallMs = performance.now() - started
  current.peakMemoryMiB = (peak - baseline) / 1024 / 1024
  const sample = current
  current = null
  return sample
}

const scenarios = [
  { name: 'small', commits: 120, files: 40, binaryBytes: 48 * 1024 },
  { name: 'medium', commits: 500, files: 200, binaryBytes: 256 * 1024 },
  { name: 'large', commits: 600, files: 300, binaryBytes: 512 * 1024 },
]

const samples: Sample[] = []
for (const scenario of scenarios) {
  await call(forge, base, 'POST', '/api/repos', token, { owner: 'bench', name: scenario.name, visibility: 'public' })
  const source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  generateHistory(source, { ...scenario, seed: 7 })
  await git(source, ['gc', '-q'])
  const packBytes = Number(/size-pack: (\d+)/.exec(await git(source, ['count-objects', '-v']))?.[1] ?? 0) * 1024
  const objects = (await git(source, ['rev-list', '--objects', '--all'])).trim().split('\n').length
  const remote = `${base}/bench/${scenario.name}.git`
  const tag = `${scenario.name} (${scenario.commits} commits, ${objects} objects, ${(packBytes / 1024 / 1024).toFixed(1)} MiB pack)`
  samples.push(await measure(`push ${tag}`, () => git(source, ['push', '-q', remote.replace('http://', `http://git:${token}@`), 'main'])))
  samples.push(await measure(`clone v2 ${tag}`, () => git(tempDir(), ['clone', '-q', remote, 'out'])))
  samples.push(await measure(`clone dumb ${tag}`, () => git(tempDir(), ['-c', 'protocol.version=0', 'clone', '-q', remote, 'out'])))
}
server.close()

console.log('| operation | requests | CPU total (ms) | CPU max per request (ms) | wall (ms) | peak JS memory (MiB) |')
console.log('|---|---|---|---|---|---|')
for (const sample of samples) {
  console.log(`| ${sample.label} | ${sample.requests} | ${Math.round(sample.cpuMs)} | ${Math.round(sample.maxRequestCpuMs)} | ${Math.round(sample.wallMs)} | ${Math.round(sample.peakMemoryMiB)} |`)
}
console.log(`peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MiB, node ${process.version}`)
