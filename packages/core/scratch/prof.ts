import { execFileSync } from 'node:child_process'
import { streamOf } from '../src/bytes.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository, ObjectDatabase } from '../src/repository.ts'
import { generateHistory, gitEnv } from '../../../apps/forge-worker/test/e2e/history.ts'
import { mkdtempSync } from 'node:fs'
const dir = mkdtempSync('/tmp/prof-')
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
generateHistory(dir, { commits: 120, files: 40, binaryBytes: 48 * 1024, seed: 7 })
const pack = new Uint8Array(execFileSync('git', ['pack-objects', '--stdout', '--revs', '--delta-base-offset', '--all'], { cwd: dir, input: '', env: { ...process.env, ...gitEnv }, maxBuffer: 1 << 30 }))
console.log('pack MiB', pack.length / 1048576)
for (let round = 0; round < 6; round++) {
  const storage = new MemoryStorage()
  const repo = { owner: 'a', name: `b${round}` }
  await createRepository(storage, repo)
  const t = performance.now(); const c = process.cpuUsage()
  const odb = new ObjectDatabase(storage, repo)
  const { pack: indexed } = await odb.ingest(streamOf(pack))
  const u = process.cpuUsage(c)
  console.log('ingest ms', performance.now() - t, 'cpu', (u.user + u.system) / 1000, 'deferred', indexed.deferred, indexed.objectCount)
}
