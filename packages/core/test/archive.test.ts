import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleArchiveRequest } from '../src/archive.ts'
import { handleGitRequest } from '../src/http.ts'
import { lfsObjectKey } from '../src/lfs.ts'
import { MemoryStorage } from '../src/memory-storage.ts'
import { createRepository } from '../src/repository.ts'
import type { ReadView } from '../src/visibility.ts'
import { commitAll, gitEnv, initRepo, tempDir, writeFile } from './git-helpers.ts'
import { type RunningServer, startServer } from './http-server.ts'

const run = promisify(execFile)
const sh = (cwd: string, command: string) => run('sh', ['-c', command], { cwd, env: { ...process.env, ...gitEnv, LC_ALL: 'C.UTF-8' }, maxBuffer: 64 * 1024 * 1024 })

const snapshot = (root: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const visit = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const path = `${rel}${name}`
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) out[path] = `link:${readlinkSync(full)}`
      else if (stat.isDirectory()) {
        out[`${path}/`] = 'dir'
        visit(full, `${path}/`)
      } else out[path] = `${stat.mode & 0o111 ? 'x' : '-'}:${readFileSync(full).toString('base64')}`
    }
  }
  visit(root, '')
  return out
}

let storage: MemoryStorage
let server: RunningServer
let view: ReadView | Response | null = null

beforeAll(async () => {
  storage = new MemoryStorage()
  server = await startServer(
    async (request) =>
      (await handleArchiveRequest(request, { storage, authorize: async () => view })) ?? (await handleGitRequest(request, { storage })) ?? new Response('not found', { status: 404 }),
  )
})

afterAll(() => server.close())

describe('source archives', () => {
  it('serves tar.gz and zip archives with the content of git archive', async () => {
    await createRepository(storage, { owner: 'acme', name: 'tool' })
    const source = initRepo()
    writeFile(source, 'README.md', '# Tool\n'.repeat(200))
    writeFile(source, 'empty.txt', '')
    writeFile(source, 'bin/run.sh', '#!/bin/sh\necho hi\n')
    chmodSync(join(source, 'bin/run.sh'), 0o755)
    const lfs = new TextEncoder().encode('large file\n')
    const oid = createHash('sha256').update(lfs).digest('hex')
    await storage.put(lfsObjectKey({ owner: 'acme', name: 'tool' }, oid), lfs, lfs.length)
    writeFile(source, 'assets/big.bin', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${lfs.length}\n`)
    writeFile(source, 'grüße/ümlaut.txt', 'hallo\n')
    writeFile(source, 'random.bin', new Uint8Array(Array.from({ length: 5000 }, (_, n) => (n * 7919) % 251)))
    await run('ln', ['-s', 'README.md', 'link.md'], { cwd: source })
    const head = commitAll(source, 'tool')
    await sh(source, `git tag v1.2.0 && git push -q ${server.url}/acme/tool.git main v1.2.0`)
    const expected = tempDir()
    await sh(source, `git archive --format=tar --prefix=tool-1.2.0/ v1.2.0 | tar -x -C ${expected}`)
    const want = snapshot(expected)
    for (const [path, file] of [
      ['/acme/tool/archive/refs/tags/v1.2.0.zip', 'a.zip'],
      ['/acme/tool/archive/refs/tags/v1.2.0.tar.gz', 'a.tar.gz'],
      ['/acme/tool/archive/v1.2.0.zip', 'b.zip'],
    ] as const) {
      const response = await fetch(`${server.url}${path}`)
      expect(response.status).toBe(200)
      const dir = tempDir()
      writeFileSync(join(dir, file), new Uint8Array(await response.arrayBuffer()))
      await sh(dir, file.endsWith('.zip') ? `unzip -q ${file} && rm ${file}` : `tar -xzf ${file} && rm ${file}`)
      expect(snapshot(dir)).toEqual(want)
    }
    const zip = tempDir()
    writeFileSync(join(zip, 'a.zip'), new Uint8Array(await (await fetch(`${server.url}/acme/tool/archive/refs/tags/v1.2.0.zip`)).arrayBuffer()))
    await sh(source, `git archive --format=zip --prefix=tool-1.2.0/ -o ${zip}/git.zip v1.2.0`)
    const listing = async (file: string) => (await sh(zip, `zipinfo -1 ${file}`)).stdout.split('\n').sort()
    expect(await listing('a.zip')).toEqual(await listing('git.zip'))
    expect((await sh(zip, 'unzip -tq a.zip')).stdout).toContain('No errors')
    expect((await sh(zip, 'unzip -z a.zip')).stdout).toContain(head)
    const ball = await fetch(`${server.url}/api/v3/repos/acme/tool/zipball/main`)
    expect(ball.headers.get('Content-Disposition')).toBe(`attachment; filename=acme-tool-${head.slice(0, 7)}.zip`)
    const tarball = await fetch(`${server.url}/api/repos/acme/tool/tarball`)
    expect(tarball.headers.get('Content-Type')).toBe('application/x-gzip')
    const dir = tempDir()
    writeFileSync(join(dir, 't.tgz'), new Uint8Array(await tarball.arrayBuffer()))
    await sh(dir, 'tar -xzf t.tgz && rm t.tgz')
    expect(Object.keys(snapshot(dir))[0]).toBe(`acme-tool-${head.slice(0, 7)}/`)
    expect((await fetch(`${server.url}/acme/tool/archive/missing.zip`)).status).toBe(404)
  })

  it('refuses archives a partial read view does not fully cover', async () => {
    view = { reach: (ref, path) => (ref === 'refs/heads/main' ? (path === '' ? 'above' : path.startsWith('bin') ? 'inside' : 'none') : 'none') }
    expect((await fetch(`${server.url}/acme/tool/archive/refs/heads/main.zip`)).status).toBe(404)
    view = { reach: (ref) => (ref === 'refs/heads/main' ? 'inside' : 'none') }
    expect((await fetch(`${server.url}/acme/tool/archive/refs/heads/main.zip`)).status).toBe(200)
    view = new Response('denied', { status: 401 })
    expect((await fetch(`${server.url}/acme/tool/archive/refs/heads/main.tar.gz`)).status).toBe(401)
    view = null
  })
})
