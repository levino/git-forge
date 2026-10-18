import { describe, expect, it } from 'vitest'
import { lfsUrlFromConfig, normalizeLfsUrl, parseGitConfig } from '../src/lfs-config.ts'

describe('.lfsconfig', () => {
  it('parses git config syntax', () => {
    const config = parseGitConfig(
      '# comment\n[lfs]\n\turl = "https://lfs.example.org/objects/batch" ; note\n\tFetchExclude = a/**\n[remote "origin"]\n\tlfsurl = https://other.example.org/x\n[core] bare\n',
    )
    expect(config.get('lfs.url')).toBe('https://lfs.example.org/objects/batch')
    expect(config.get('lfs.fetchexclude')).toBe('a/**')
    expect(config.get('remote.origin.lfsurl')).toBe('https://other.example.org/x')
    expect(config.get('core.bare')).toBe('true')
  })

  it('resolves the endpoint with the precedence of git-lfs', () => {
    expect(lfsUrlFromConfig(parseGitConfig('[lfs]\nurl = https://lfs.example.org/objects/batch\n[remote "origin"]\nlfsurl = https://other.example.org/x\n'))).toBe(
      'https://lfs.example.org',
    )
    expect(lfsUrlFromConfig(parseGitConfig('[remote "origin"]\nlfsurl = https://other.example.org/x/\n'))).toBe('https://other.example.org/x')
    expect(lfsUrlFromConfig(parseGitConfig('[remote "upstream"]\nlfsurl = https://other.example.org/x\n'))).toBeNull()
  })

  it('normalizes endpoint URLs', () => {
    expect(normalizeLfsUrl('https://git-lfs.archiv.xn--rssing-wxa.de/objects/batch')).toBe('https://git-lfs.archiv.xn--rssing-wxa.de')
    expect(normalizeLfsUrl('https://host.example/repo/info/lfs/')).toBe('https://host.example/repo/info/lfs')
    expect(normalizeLfsUrl('https://user:secret@host.example/lfs')).toBeNull()
    expect(normalizeLfsUrl('ssh://host.example/repo')).toBeNull()
  })
})
