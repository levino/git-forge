import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { concat, fromUtf8, readAll } from '../src/bytes.ts'
import { DELIM, FLUSH, pkt } from '../src/pktline.ts'
import { readRefs } from '../src/repository.ts'
import { uploadPackV2 } from '../src/upload-pack.ts'
import { commitReach, pathReach, type ReadView, visibleRefs } from '../src/visibility.ts'
import { git, tempDir } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

const view: ReadView = {
  reach: (ref, path) => (ref === 'refs/heads/release' ? 'inside' : ref === 'refs/heads/main' ? pathReach('docs', path) : 'none'),
}

const setup = async () => {
  const dir = tempDir()
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'secret.txt'), 'secret\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'main'])
  const main = git(dir, ['rev-parse', 'HEAD']).trim()
  git(dir, ['checkout', '-q', '--orphan', 'release'])
  writeFileSync(join(dir, 'release.txt'), 'release\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'release'])
  const release = git(dir, ['rev-parse', 'HEAD']).trim()
  return { ...(await loadRepository(dir)), main, release }
}

const command = async (loaded: Awaited<ReturnType<typeof setup>>, name: string, args: readonly string[]) =>
  fromUtf8(await readAll(await uploadPackV2(loaded.storage, loaded.repo, concat([pkt(`command=${name}\n`), DELIM, ...args.map((arg) => pkt(`${arg}\n`)), FLUSH]), { view })))

describe('read views', () => {
  it('reaches paths below, above and beside an allowed path', () => {
    expect([pathReach('docs', 'docs/a.md'), pathReach('docs', ''), pathReach('docs/x', 'docs'), pathReach('docs', 'src'), pathReach(null, 'src')]).toEqual(['inside', 'above', 'above', 'none', 'inside'])
  })

  it('advertises and sends only refs whose whole tree is visible', async () => {
    const loaded = await setup()
    const refs = await command(loaded, 'ls-refs', ['symrefs'])
    expect(refs).toContain(`${loaded.release} HEAD symref-target:refs/heads/release`)
    expect(refs).not.toContain('refs/heads/main')
    expect(await command(loaded, 'fetch', [`want ${loaded.main}`, 'done'])).toContain(`ERR not our ref ${loaded.main}`)
    const fetched = await command(loaded, 'fetch', [`want ${loaded.release}`, `have ${loaded.main}`])
    expect(fetched).toContain('NAK')
    expect(fetched).not.toContain(`ACK ${loaded.main}`)
  })

  it('gives commits the paths of the visible refs that reach them', async () => {
    const loaded = await setup()
    const state = (await readRefs(loaded.storage, loaded.repo))!.state
    expect(Object.keys(visibleRefs(state, view).refs).sort()).toEqual(['refs/heads/main', 'refs/heads/release'])
    const reach = await commitReach(loaded.odb, state, view, loaded.main)
    expect([reach?.('docs/guide.md'), reach?.('secret.txt')]).toEqual(['inside', 'none'])
  })
})
