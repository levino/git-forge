import { describe, expect, it } from 'vitest'
import { git, initRepo, writeFile } from '@git-forge/core/test/git-helpers.ts'
import { compileCodeOwnersPattern, matchCodeOwners, ownersOf, parseCodeOwners } from '../src/codeowners.ts'

const PATTERNS = [
  '*',
  '*.js',
  'apps/',
  '/build/logs/',
  '**/logs',
  'logs/**',
  'a/**/b',
  'foo',
  '/foo',
  'x/y',
  '/docs/',
  'src/*.ts',
  'src/**/*.ts',
  '?.md',
  'docs/**/README.md',
  'nested/deep',
  'README.md',
  '/README.md',
  'a*b/c',
  '**',
  'x/**/',
]

const PATHS = [
  'README.md',
  'docs/README.md',
  'docs/a.md',
  'docs/b/c.md',
  'docs/guide/x/README.md',
  'apps/x.js',
  'q/apps/y',
  'apps',
  'build/logs/z.txt',
  'build/logs/deep/z',
  'q/logs/w',
  'logs/w',
  'logs',
  'a/b',
  'a/x/y/b',
  'a/b/c',
  'q.js',
  'd/q.js',
  'foo',
  'foo/bar',
  'd/foo',
  'x/foo',
  'x/y',
  'x/y/z',
  'q/x/y',
  'src/app.ts',
  'src/lib/util.ts',
  'src/app.js',
  'a.md',
  'ab.md',
  'nested/deep/file',
  'top/nested/deep/file',
  'axxb/c',
  'ab/c/d',
  'x/q/r',
]

describe('CODEOWNERS patterns', () => {
  it('match like git check-ignore for every pattern GitHub interprets the gitignore way', () => {
    const dir = initRepo()
    for (const pattern of PATTERNS) {
      writeFile(dir, '.gitignore', `${pattern}\n`)
      let output = ''
      try {
        output = git(dir, ['check-ignore', '--no-index', '--stdin'], { input: PATHS.join('\n') })
      } catch (error) {
        output = (error as { stdout?: string }).stdout ?? ''
      }
      const expected = output.split('\n').filter((line) => line !== '')
      const matcher = compileCodeOwnersPattern(pattern)
      expect(PATHS.filter(matcher), pattern).toEqual(expected)
    }
  })

  it('does not let a trailing /* match nested files, as GitHub documents', () => {
    const matcher = compileCodeOwnersPattern('docs/*')
    expect(['docs/getting-started.md', 'docs/build-app/troubleshooting.md', 'other/docs/a.md'].filter(matcher)).toEqual(['docs/getting-started.md'])
  })
})

describe('CODEOWNERS files', () => {
  const text = [
    '# default owners',
    '*       @global-owner1 @global-owner2',
    '*.js    @js-owner #This is an inline comment.',
    '*.go docs@example.com',
    '*.txt @octo-org/octocats',
    '/build/logs/ @doctocat',
    'docs/* docs@example.com',
    'apps/ @octocat',
    '/docs/ @doctocat',
    '/scripts/ @doctocat @octocat',
    '**/logs @octocat',
    '/apps/ @octocat',
    '/apps/github',
    '!negated @nobody',
    'file[0-9].md @nobody',
    'odd @not/a/valid/team',
    'with\\ space.md @spacer',
  ].join('\n')
  const codeowners = parseCodeOwners(text, '.github/CODEOWNERS')

  it('parses owners, comments and the documented examples, last match wins', () => {
    expect(ownersOf(codeowners, 'main.c')).toEqual([
      { kind: 'user', login: 'global-owner1' },
      { kind: 'user', login: 'global-owner2' },
    ])
    expect(ownersOf(codeowners, 'src/app.js')).toEqual([{ kind: 'user', login: 'js-owner' }])
    expect(ownersOf(codeowners, 'main.go')).toEqual([{ kind: 'email', email: 'docs@example.com' }])
    expect(ownersOf(codeowners, 'notes/a.txt')).toEqual([{ kind: 'team', organization: 'octo-org', slug: 'octocats' }])
    expect(ownersOf(codeowners, 'build/logs/out.txt')).toEqual([{ kind: 'user', login: 'octocat' }])
    expect(ownersOf(codeowners, 'docs/build-app/troubleshooting.md')).toEqual([{ kind: 'user', login: 'doctocat' }])
    expect(ownersOf(codeowners, 'apps/github/index.js')).toEqual([])
    expect(matchCodeOwners(codeowners, 'apps/github/index.js')?.line).toBe(13)
    expect(ownersOf(codeowners, 'apps/other/index.js')).toEqual([{ kind: 'user', login: 'octocat' }])
    expect(ownersOf(codeowners, 'with space.md')).toEqual([{ kind: 'user', login: 'spacer' }])
  })

  it('reports unsupported syntax and invalid owners with line numbers', () => {
    expect(codeowners.errors).toEqual([
      { line: 14, message: 'negation is not supported: !negated' },
      { line: 15, message: 'character ranges are not supported: file[0-9].md' },
      { line: 16, message: 'unknown owner @not/a/valid/team' },
    ])
    expect(codeowners.rules.find((rule) => rule.pattern === 'odd')?.owners).toEqual([])
  })
})
