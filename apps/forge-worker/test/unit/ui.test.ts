import { describe, expect, it } from 'vitest'
import { uiEnabled } from '../../src/config.ts'
import { isCrossSiteWrite, isForgePath, isLoginPath } from '../../src/routing.ts'
import { previewKind } from '../../src/ui/browse.ts'
import { formatBytes, relativeTime } from '../../src/ui/format.ts'
import { HIGHLIGHT_CSS, highlightHunks, highlightLines, languageFor } from '../../src/ui/highlight.ts'
import { parsePage } from '../../src/ui/history.ts'
import { renderMarkdown, resolveRelative } from '../../src/ui/markdown.ts'

describe('routing between the UI and the forge', () => {
  it.each([
    '/api',
    '/api/health',
    '/api/v3/repos/a/b/actions/runs',
    '/_services/actions/_apis/connectionData',
    '/_pages/authorize',
    '/.well-known/jwks.json',
    '/login',
    '/login/device',
    '/login/device/code',
    '/login/oidc/callback',
    '/login/passkey/options',
    '/logout',
    '/api/session',
    '/acme/site.git/info/refs',
    '/acme/site/info/refs',
    '/acme/site/HEAD',
    '/acme/site/git-upload-pack',
    '/acme/site/git-receive-pack',
    '/acme/site/objects/info/packs',
    '/acme/site/info/lfs/objects/batch',
    '/acme/site/forge/uploads',
    '/acme/site/forge/uploads/2026-10-18T12-00-00-000Z-0b5b7c38-8a43-4a52-9c1e-6a3d9b0f1e2d/finalize',
    `/acme/site/media/${'a'.repeat(64)}`,
    '/acme/site/raw/main/README.md',
    '/acme/site/releases/download/v1.0/app.tar.gz',
    '/acme/site/archive/refs/tags/v1.0.zip',
    '/acme/site/archive/main.tar.gz',
  ])('sends %s to the forge', (path) => {
    expect(isForgePath(path)).toBe(true)
  })

  it.each(['/', '/explore', '/settings', '/acme/site.git', '/acme', '/acme/site', '/acme/site/tree/main/src', '/acme/site/blob/main/info/refs', '/acme/site/commits', '/acme/site/releases', '/acme/site/releases/tag/v1.0', '/notifications', '/-/style.css'])(
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

  it('recognizes the login routes whose requests may be rendered as pages', () => {
    expect(['/login', '/logout', '/login/device', '/login/break-glass'].every(isLoginPath)).toBe(true)
    expect(['/loginx', '/api/session', '/acme/site.git/info/refs'].some(isLoginPath)).toBe(false)
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
    expect(lines[0]![0]).toEqual({ content: 'const', className: expect.stringMatching(/^l\d+ d\d+$/) })
    expect(lines.flat().some((token) => token.className === '' && token.content.includes(' '))).toBe(true)
    expect(lines[1]).toEqual([])
    for (const name of lines.flat().flatMap((token) => token.className.split(' ').filter(Boolean))) expect(HIGHLIGHT_CSS).toMatch(new RegExp(`\\.${name}\\{color:#[0-9A-F]{6}\\}`))
    expect(await highlightLines('<b>\n', 'notes')).toEqual([[{ content: '<b>', className: '' }]])
  })

  it('highlights fenced Markdown code after sanitizing and leaves unknown fences plain', async () => {
    const base = { blob: '/a/b/blob/main', raw: '/a/b/raw/main', directory: '' }
    const html = await renderMarkdown('```ts\nconst a = "<script>"\n```\n\n```nope\nx\n```\n\n<span style="color:red">y</span>', base)
    expect(html).toMatch(/<pre class="hl"><code class="language-ts"><span class="l\d+ d\d+">const<\/span>/)
    expect(html).toContain('&#x3C;script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<pre><code class="language-nope">x')
    expect(html).not.toContain('color:red')
  })

  it('highlights both sides of diff hunks line by line', async () => {
    const line = (kind: ' ' | '-' | '+', text: string) => ({ kind, text, oldLine: null, newLine: null, noNewline: false })
    const [hunk] = await highlightHunks([{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, section: '', lines: [line(' ', 'let a = 1'), line('-', 'a = 2'), line('+', 'a = 3')] }], 'x.ts')
    expect(hunk!.map((tokens) => tokens.map((token) => token.content).join(''))).toEqual(['let a = 1', 'a = 2', 'a = 3'])
    expect(hunk![0]![0]!.className).toMatch(/^l\d+ d\d+$/)
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
