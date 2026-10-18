import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromUtf8, maybeGunzip, readAll, readTar, streamOf, TarFormatError } from '../src/index.ts'

const chunked = (bytes: Uint8Array, size: number): ReadableStream<Uint8Array> => {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}

const collect = async (stream: ReadableStream<Uint8Array>) => {
  const entries: { path: string; type: string; text: string; linkName: string }[] = []
  for await (const entry of readTar(stream)) {
    const parts: Uint8Array[] = []
    if (entry.path.endsWith('skip.txt')) {
      entries.push({ path: entry.path, type: entry.type, text: '', linkName: entry.linkName })
      continue
    }
    for await (const part of entry.body) parts.push(part)
    entries.push({ path: entry.path, type: entry.type, text: fromUtf8(await readAll(new Blob(parts as BlobPart[]).stream())), linkName: entry.linkName })
  }
  return entries
}

const site = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'tar-test-'))
  const root = join(dir, 'site')
  mkdirSync(join(root, 'nested', 'x'.repeat(90)), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<h1>hi</h1>')
  writeFileSync(join(root, 'skip.txt'), 'y'.repeat(5000))
  writeFileSync(join(root, 'nested', 'x'.repeat(90), 'deep.txt'), 'deep')
  writeFileSync(join(root, 'big.bin'), 'z'.repeat(70_000))
  symlinkSync('index.html', join(root, 'link.html'))
  return dir
}

describe('readTar', () => {
  for (const format of ['ustar', 'pax', 'gnu']) {
    it(`reads ${format} archives written by tar, including long names and skipped bodies`, async () => {
      const dir = site()
      const archive = new Uint8Array(execFileSync('tar', ['--format', format, '-cf', '-', '-C', join(dir, 'site'), '.'], { maxBuffer: 1 << 24 }))
      const entries = await collect(chunked(archive, 777))
      const files = Object.fromEntries(entries.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry.text]))
      expect(files['./index.html']).toBe('<h1>hi</h1>')
      expect(files['./big.bin']).toBe('z'.repeat(70_000))
      expect(files[`./nested/${'x'.repeat(90)}/deep.txt`]).toBe('deep')
      expect(entries.find((entry) => entry.path === './link.html')).toMatchObject({ type: 'symlink', linkName: 'index.html' })
      expect(entries.some((entry) => entry.type === 'directory' && entry.path.startsWith('./nested'))).toBe(true)
    })
  }

  it('gunzips compressed archives and passes plain ones through', async () => {
    const dir = site()
    const archive = new Uint8Array(execFileSync('tar', ['-czf', '-', '-C', join(dir, 'site'), 'index.html']))
    const entries = await collect(await maybeGunzip(streamOf(archive)))
    expect(entries).toEqual([{ path: 'index.html', type: 'file', text: '<h1>hi</h1>', linkName: '' }])
    expect(fromUtf8(await readAll(await maybeGunzip(streamOf(new TextEncoder().encode('plain')))))).toBe('plain')
  })

  it('rejects corrupt headers', async () => {
    const block = new Uint8Array(512).fill(65)
    await expect(collect(streamOf(block))).rejects.toThrow(TarFormatError)
  })
})
