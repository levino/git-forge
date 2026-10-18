import { chmodSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { diffBlobs, diffTrees, diffTreesWithContent, formatFileDiff, isBinaryContent } from '../src/diff.ts'
import { utf8 } from '../src/bytes.ts'
import { commitAll, git, initRepo, writeFile } from './git-helpers.ts'
import { loadRepository } from './repo-helpers.ts'

const pointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`

const history = () => {
  const dir = initRepo()
  writeFile(dir, 'README.md', Array.from({ length: 40 }, (_, i) => `function line${i}() {\n`).join(''))
  writeFile(dir, 'old/name.txt', 'moved content\n')
  writeFile(dir, 'gone.txt', 'gone\n')
  writeFile(dir, 'script.sh', 'echo hi\n')
  writeFile(dir, 'image.bin', new Uint8Array([1, 0, 2, 3]))
  writeFile(dir, 'media/photo.jpg', pointer('a'.repeat(64), 10))
  writeFile(dir, 'tail.txt', 'no newline')
  const first = commitAll(dir, 'first')
  writeFile(dir, 'README.md', Array.from({ length: 40 }, (_, i) => (i === 20 ? 'changed\n' : `function line${i}() {\n`)).join(''))
  rmSync(join(dir, 'old'), { recursive: true })
  writeFile(dir, 'new/name.txt', 'moved content\n')
  rmSync(join(dir, 'gone.txt'))
  chmodSync(join(dir, 'script.sh'), 0o755)
  writeFile(dir, 'image.bin', new Uint8Array([1, 0, 2, 4]))
  writeFile(dir, 'media/photo.jpg', pointer('b'.repeat(64), 12))
  writeFile(dir, 'tail.txt', 'no newline either')
  symlinkSync('README.md', join(dir, 'link'))
  writeFile(dir, 'added/deep/file.txt', 'hello\n')
  const second = commitAll(dir, 'second')
  return { dir, first, second }
}

describe('diff', () => {
  it('produces the same patch as git diff', async () => {
    const { dir, first, second } = history()
    const { odb } = await loadRepository(dir)
    const tree = (id: string) => git(dir, ['rev-parse', `${id}^{tree}`]).trim()
    const files = await diffTreesWithContent(odb, tree(first), tree(second))
    const expected = git(dir, ['diff', '--no-indent-heuristic', '--find-renames=100%', first, second])
    expect(files.map(formatFileDiff).join('')).toBe(expected)
    expect(files.map((file) => [file.path, file.status, file.kind])).toEqual([
      ['README.md', 'modified', 'text'],
      ['added/deep/file.txt', 'added', 'text'],
      ['gone.txt', 'removed', 'text'],
      ['image.bin', 'modified', 'binary'],
      ['link', 'added', 'text'],
      ['media/photo.jpg', 'modified', 'lfs'],
      ['new/name.txt', 'renamed', 'text'],
      ['script.sh', 'modified', 'text'],
      ['tail.txt', 'modified', 'text'],
    ])
    const lfs = files.find((file) => file.kind === 'lfs')!
    expect(lfs.lfs).toEqual({ old: { oid: 'a'.repeat(64), size: 10 }, new: { oid: 'b'.repeat(64), size: 12 } })
    const readme = files[0]!
    expect([readme.additions, readme.deletions]).toEqual([1, 1])
    expect(readme.hunks[0]).toMatchObject({ oldStart: 18, oldLines: 7, newStart: 18, newLines: 7, section: 'function line16() {' })
  })

  it('reports name-status like git without rename detection', async () => {
    const { dir, first, second } = history()
    const { odb } = await loadRepository(dir)
    const tree = (id: string) => git(dir, ['rev-parse', `${id}^{tree}`]).trim()
    const changes = await diffTrees(odb, tree(first), tree(second), { renames: false })
    const letter = { added: 'A', removed: 'D', modified: 'M', renamed: 'R' }
    expect(changes.map((change) => `${letter[change.status]}\t${change.path}`).join('\n')).toBe(
      git(dir, ['diff', '--name-status', '--no-renames', first, second]).trim(),
    )
  })

  it('detects binary content and counts lines', () => {
    expect(isBinaryContent(new Uint8Array([65, 0]))).toBe(true)
    expect(isBinaryContent(utf8('text'))).toBe(false)
    expect(diffBlobs(utf8(''), utf8('a\nb\n'))).toMatchObject({ additions: 2, deletions: 0, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] })
  })
})
