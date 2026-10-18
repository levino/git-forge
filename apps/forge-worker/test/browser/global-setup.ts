import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { startServer } from '@git-forge/core/test/http-server.ts'
import { basicAuth, chain, httpBackendHandler, requireAuthorization } from '@git-forge/core/test/mirror-helpers.ts'
import build from '../e2e/build.ts'
import { gitEnv, tempDir } from '../e2e/history.ts'
import { startWranglerDev } from '../e2e/wrangler-dev.ts'

const run = promisify(execFile)

const lfsFilterConfig = [
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.required', 'true'],
] as const

const env = {
  ...process.env,
  ...gitEnv,
  GIT_CONFIG_COUNT: String(lfsFilterConfig.length),
  ...Object.fromEntries(lfsFilterConfig.flatMap(([key, value], i) => [[`GIT_CONFIG_KEY_${i}`, key], [`GIT_CONFIG_VALUE_${i}`, value]])),
}

const git = async (cwd: string, args: readonly string[]): Promise<string> => (await run('git', args, { cwd, env, maxBuffer: 64 * 1024 * 1024 })).stdout

const write = (root: string, path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC'),
  (character) => character.charCodeAt(0),
)

const UPSTREAM_TOKEN = `upstream-${crypto.randomUUID()}`

export default async function setup(): Promise<() => Promise<void>> {
  await build()
  const bootstrapToken = `browser-${crypto.randomUUID()}`
  const dev = await startWranglerDev({ vars: { BOOTSTRAP_TOKEN: bootstrapToken } })
  const post = async (path: string, token: string, body: unknown) => {
    const response = await fetch(`${dev.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return (await response.json()) as Record<string, unknown>
  }
  const token = String((await post('/api/bootstrap', bootstrapToken, { login: 'octo' })).token)
  await post('/api/repos', token, { owner: 'octo', name: 'gallery', visibility: 'public' })
  await post('/api/repos', token, { owner: 'octo', name: 'hidden', visibility: 'private' })
  const dir = tempDir()
  await git(dir, ['init', '-q', '-b', 'main'])
  await git(dir, ['lfs', 'install', '--local'])
  await git(dir, ['config', 'lfs.locksverify', 'false'])
  await git(dir, ['remote', 'add', 'origin', `${dev.url.replace('http://', `http://git:${token}@`)}/octo/gallery.git`])
  await git(dir, ['lfs', 'track', '*.png'])
  write(dir, 'README.md', '# Gallery\n\nPictures live in [images](images).\n')
  write(dir, 'images/pixel.png', PNG)
  write(dir, 'src/app.ts', 'export const greet = (name: string) => `Hello ${name}`\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-q', '-m', 'Add the gallery'])
  write(dir, 'src/app.ts', 'export const greet = (name: string) => `Hello, ${name}!`\n')
  await git(dir, ['commit', '-q', '-am', 'Punctuate the greeting'])
  await git(dir, ['checkout', '-q', '-b', 'polish'])
  write(dir, 'src/app.ts', 'export const greet = (name: string) => `Hello, ${name}!`\nexport const bye = () => "Bye"\n')
  await git(dir, ['commit', '-q', '-am', 'Say goodbye'])
  await git(dir, ['lfs', 'push', '--all', 'origin'])
  await git(dir, ['push', '-q', 'origin', 'main', 'polish'])
  await post('/api/v3/repos/octo/gallery/pulls', token, { title: 'Say goodbye', head: 'polish', base: 'main' })
  for (const project of ['desktop', 'mobile']) {
    await post('/api/repos', token, { owner: 'octo', name: `pipeline-${project}`, visibility: 'public' })
    const pipeline = tempDir()
    await git(pipeline, ['init', '-q', '-b', 'main'])
    write(pipeline, '.github/workflows/ci.yml', 'name: Build\non: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n')
    await git(pipeline, ['add', '-A'])
    await git(pipeline, ['commit', '-q', '-m', 'Add a workflow'])
    await git(pipeline, ['push', '-q', `${dev.url.replace('http://', `http://git:${token}@`)}/octo/pipeline-${project}.git`, 'main'])
  }
  await post('/api/repos', token, { owner: 'octo', name: 'copy', visibility: 'private' })
  await post('/api/repos/octo/copy/mirrors', token, { url: 'https://upstream.example/octo/copy.git', mode: 'manual' })
  const upstreamRoot = tempDir()
  const upstreamSource = join(upstreamRoot, 'source')
  mkdirSync(upstreamSource)
  await git(upstreamSource, ['init', '-q', '-b', 'main'])
  write(upstreamSource, 'README.md', '# Upstream\n\nImported from a local fixture.\n')
  await git(upstreamSource, ['add', '-A'])
  await git(upstreamSource, ['commit', '-q', '-m', 'Start upstream'])
  write(upstreamSource, 'notes.txt', 'second commit\n')
  await git(upstreamSource, ['add', '-A'])
  await git(upstreamSource, ['commit', '-q', '-m', 'Add notes'])
  await git(upstreamSource, ['tag', 'v1.0.0'])
  await git(upstreamRoot, ['clone', '-q', '--bare', upstreamSource, 'upstream.git'])
  const upstream = await startServer(chain(requireAuthorization(basicAuth('git', UPSTREAM_TOKEN)), httpBackendHandler(upstreamRoot)))
  process.env.FORGE_URL = dev.url
  process.env.FORGE_ADMIN_TOKEN = token
  process.env.UPSTREAM_URL = `${upstream.url}/upstream.git`
  process.env.UPSTREAM_TOKEN = UPSTREAM_TOKEN
  return async () => {
    await upstream.close()
    await dev.stop()
  }
}
