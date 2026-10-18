import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  applyOption,
  capabilitiesResponse,
  isRemoteHelperName,
  defaultOptions,
  partRanges,
  parsePushLine,
  parseRefList,
  pushResponse,
  refOutcomes,
  remoteHttpUrl,
  splitCredentials,
  uploadKey,
  uploadsUrl,
  ZERO_ID,
} from '../src/helper-protocol.ts'
import { LineReader } from '../src/line-reader.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('remote helper protocol', () => {
  it('advertises stateless-connect for fetches and push for the upload path', () => {
    expect(capabilitiesResponse()).toBe('stateless-connect\nfetch\npush\noption\n\n')
  })

  it('maps forge:: addresses and forge:// URLs to the smart HTTP URL', () => {
    expect(remoteHttpUrl('https://forge.example/acme/site')).toBe('https://forge.example/acme/site')
    expect(remoteHttpUrl('https://forge.example/acme/site.git/')).toBe('https://forge.example/acme/site.git')
    expect(remoteHttpUrl('forge://forge.example/acme/site')).toBe('https://forge.example/acme/site')
    expect(remoteHttpUrl('http://127.0.0.1:8080/acme/site')).toBe('http://127.0.0.1:8080/acme/site')
    expect(() => remoteHttpUrl('ssh://forge.example/acme/site')).toThrow(/http/)
    expect(uploadsUrl('https://forge.example/acme/site')).toBe('https://forge.example/acme/site/forge/uploads')
  })

  it('takes credentials out of the URL', () => {
    expect(splitCredentials('https://git:gfp%2Fx@forge.example/acme/site')).toEqual({
      url: 'https://forge.example/acme/site',
      credential: { username: 'git', password: 'gfp/x' },
    })
    expect(splitCredentials('https://forge.example/acme/site')).toEqual({ url: 'https://forge.example/acme/site', credential: null })
  })

  it('parses push commands with force, deletion and arbitrary sources', () => {
    expect(parsePushLine('push refs/heads/main:refs/heads/main')).toEqual({ force: false, src: 'refs/heads/main', dst: 'refs/heads/main' })
    expect(parsePushLine('push +HEAD:refs/heads/topic')).toEqual({ force: true, src: 'HEAD', dst: 'refs/heads/topic' })
    expect(parsePushLine('push :refs/tags/old')).toEqual({ force: false, src: null, dst: 'refs/tags/old' })
    expect(parsePushLine(`push ${A}:refs/heads/x`)).toEqual({ force: false, src: A, dst: 'refs/heads/x' })
    expect(() => parsePushLine('push main')).toThrow(/refspec/)
    expect(() => parsePushLine('push main:main')).toThrow(/destination/)
  })

  it('reads the ref list relayed from git-remote-http', () => {
    const refs = parseRefList(`@refs/heads/main HEAD\n${A} refs/heads/main\n${B} refs/tags/v1\n? refs/heads/unknown\n:object-format sha1\n`)
    expect([...refs]).toEqual([
      ['refs/heads/main', A],
      ['refs/tags/v1', B],
    ])
  })

  it('tracks the options the push path needs', () => {
    const options = defaultOptions()
    applyOption(options, 'option progress true')
    applyOption(options, 'option verbosity 2')
    applyOption(options, 'option atomic true')
    applyOption(options, 'option dry-run false')
    applyOption(options, `option cas refs/heads/main:${A}`)
    applyOption(options, 'option cas "refs/heads/new:"')
    expect(options).toEqual({ verbosity: 2, progress: true, dryRun: false, atomic: true, cas: new Map([['refs/heads/main', A], ['refs/heads/new', ZERO_ID]]) })
  })

  it('formats per-ref ok and error lines', () => {
    expect(pushResponse([['refs/heads/main', { ok: true }], ['refs/heads/x', { ok: false, reason: 'protected branch: no\nforce' }]])).toBe(
      'ok refs/heads/main\nerror refs/heads/x protected branch: no force\n\n',
    )
    const specs = [
      { force: false, src: 'a', dst: 'refs/heads/a' },
      { force: false, src: 'b', dst: 'refs/heads/b' },
    ]
    expect(refOutcomes(specs, 'ok', [{ name: 'refs/heads/a', ok: true }])).toEqual([
      ['refs/heads/a', { ok: true }],
      ['refs/heads/b', { ok: false, reason: 'no result from the forge' }],
    ])
    expect(refOutcomes(specs, 'error invalid pack', [])[0]).toEqual(['refs/heads/a', { ok: false, reason: 'invalid pack' }])
  })

  it('derives a stable upload key and part ranges', () => {
    expect(uploadKey('u', [B, A], [A])).toBe(uploadKey('u', [A, B, A], [A, A]))
    expect(uploadKey('u', [A], [])).not.toBe(uploadKey('u', [A], [B]))
    expect(partRanges(10, 4)).toEqual([
      { offset: 0, size: 4 },
      { offset: 4, size: 4 },
      { offset: 8, size: 2 },
    ])
    expect(partRanges(0, 4)).toEqual([])
    expect(() => partRanges(10, 0)).toThrow()
  })

  it('reads lines and then raw bytes from one stream', async () => {
    const stream = new PassThrough()
    const reader = new LineReader(stream)
    stream.write('capabilities\nlist for-push\n\nstateless-connect git-upload-pack\n0014command=ls-refs')
    stream.end('\n0000')
    expect(await reader.readLine()).toBe('capabilities')
    expect(await reader.readBlock()).toEqual(['list for-push'])
    expect(await reader.readLine()).toBe('stateless-connect git-upload-pack')
    const rest: Buffer[] = []
    for await (const chunk of reader.rest()) rest.push(chunk)
    expect(Buffer.concat(rest).toString()).toBe('0014command=ls-refs\n0000')
    expect(await reader.readLine()).toBeNull()
  })

  it('recognizes the remote helper name of the single executable', () => {
    expect(isRemoteHelperName('/usr/local/bin/git-remote-forge')).toBe(true)
    expect(isRemoteHelperName('C:\\bin\\git-remote-forge.exe')).toBe(true)
    expect(isRemoteHelperName('git-forge')).toBe(false)
  })
})
