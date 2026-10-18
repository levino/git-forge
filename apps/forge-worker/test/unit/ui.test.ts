import { describe, expect, it } from 'vitest'
import { uiEnabled } from '../../src/config.ts'
import { isCrossSiteWrite, isForgePath } from '../../src/routing.ts'
import { previewKind } from '../../src/ui/browse.ts'
import { formatBytes, relativeTime } from '../../src/ui/format.ts'
import { highlightLines, languageFor } from '../../src/ui/highlight.ts'
import { parsePage } from '../../src/ui/history.ts'
import { renderMarkdown, resolveRelative } from '../../src/ui/markdown.ts'

describe('routing between the UI and the forge', () => {
  it.each([
    '/api',
    '/api/health',
    '/api/v3/repos/a/b/actions/runs',
    '/_services/actions/_apis/connectionData',
    '/.well-known/jwks.json',
    '/login/device/code',
    '/login/oauth/access_token',
    '/acme/site.git/info/refs',
    '/acme/site/info/refs',
    '/acme/site/HEAD',
    '/acme/site/git-upload-pack',
    '/acme/site/git-receive-pack',
    '/acme/site/objects/info/packs',
    '/acme/site/info/lfs/objects/batch',
    `/acme/site/media/${'a'.repeat(64)}`,
    '/acme/site/raw/main/README.md',
  ])('sends %s to the forge', (path) => {
    expect(isForgePath(path)).toBe(true)
  })

  it.each(['/', '/explore', '/login', '/acme/site.git', '/login/device', '/acme', '/acme/site', '/acme/site/tree/main/src', '/acme/site/blob/main/info/refs', '/acme/site/commits', '/-/style.css'])(
    'renders %s in the UI',
    (path) => {
      expect(isForgePath(path)).toBe(false)
    },
  )

  it('refuses cross-site writes and allows same-origin and non-browser requests', () => {
    const post = (headers: Record<string, string>) => new Request('https://forge.example/acme/site/settings', { method: 'POST', headers })
    expect(isCrossSiteWrite(post({ Origin: 'https://evil.example' }))).toBe(true)
    expect(isCrossSiteWrite(post({ Origin: 'https://forge.example' }))).toBe(false)
    expect(isCrossSiteWrite(post({ 'Sec-Fetch-Site': 'cross-site' }))).toBe(true)
    expect(isCrossSiteWrite(post({ 'Content-Type': 'application/x-www-form-urlencoded' }))).toBe(true)
    expect(isCrossSiteWrite(post({ 'Content-Type': 'application/json' }))).toBe(false)
    expect(isCrossSiteWrite(new Request('https://forge.example/', { headers: { Origin: 'https://evil.example' } }))).toBe(false)
  })

  it('turns the UI off only when asked', () => {
    expect(uiEnabled({})).toBe(true)
    expect(uiEnabled({ UI: 'true' })).toBe(true)
    expect(uiEnabled({ UI: ' FALSE ' })).toBe(false)
  })
})

describe('markdown', () => {
  const base = { blob: '/acme/site/blob/main', raw: '/acme/site/raw/main', directory: 'docs' }

  it('renders GitHub-flavoured Markdown and strips anything active', async () => {
    const html = await renderMarkdown(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1))\n\n<iframe src="https://evil.example"></iframe>\n',
      base,
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe/i)
  })

  it('points relative links at the repository and leaves absolute ones alone', async () => {
    const html = await renderMarkdown('[guide](../guide.md#top) ![logo](img/logo%20big.png) [home](https://example.org) [anchor](#usage) [abs](/acme)', base)
    expect(html).toContain('href="/acme/site/blob/main/guide.md#top"')
    expect(html).toContain('src="/acme/site/raw/main/docs/img/logo%2520big.png"')
    expect(html).toContain('href="https://example.org"')
    expect(html).toContain('href="#usage"')
    expect(html).toContain('href="/acme"')
  })

  it('resolves relative paths without escaping the repository', () => {
    expect(resolveRelative('a/b', '../../../x.md')).toBe('x.md')
    expect(resolveRelative('', './x y.md?raw=1')).toBe('x%20y.md?raw=1')
  })
})

describe('highlighting', () => {
  it('picks a language from the file name', () => {
    expect(languageFor('index.ts')).toBe('typescript')
    expect(languageFor('Dockerfile')).toBe('dockerfile')
    expect(languageFor('Dockerfile.dev')).toBe('dockerfile')
    expect(languageFor('notes')).toBeNull()
    expect(languageFor('.bashrc')).toBeNull()
  })

  it('returns themed tokens per line and plain lines for unknown files', async () => {
    const lines = await highlightLines('const a = 1\n\nexport { a }\n', 'a.ts')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.map((token) => token.content).join('')).toBe('const a = 1')
    expect(lines[0]![0]!.style).toMatch(/--shiki-light:#[0-9A-F]{6};--shiki-dark:#[0-9A-F]{6}/i)
    expect(lines[1]).toEqual([])
    expect(await highlightLines('<b>\n', 'notes')).toEqual([[{ content: '<b>', style: '' }]])
  })
})

describe('formatting', () => {
  it('formats sizes, times, pages and previews', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
    expect(relativeTime(1000, 1000 + 3600 * 3)).toBe('3 hours ago')
    expect(relativeTime(0, 86400 * 400)).toBe('last year')
    expect(parsePage('3')).toBe(3)
    expect(parsePage('-1')).toBe(1)
    expect(parsePage('x')).toBe(1)
    expect(previewKind('a.PNG')).toBe('image')
    expect(previewKind('a.webm')).toBe('video')
    expect(previewKind('a.flac')).toBe('audio')
    expect(previewKind('a.pdf')).toBe('pdf')
    expect(previewKind('a.zip')).toBeNull()
  })
})
