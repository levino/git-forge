import { describe, expect, it } from 'vitest'
import { allowed, DEFAULT_SETTINGS, localNumbers, parseClosingReferences, parseReferences, type PermissionSubject, stripCode } from '../src/index.ts'

const subject = (overrides: Partial<PermissionSubject> = {}): PermissionSubject => ({
  access: 'read',
  authenticated: true,
  writable: true,
  settings: DEFAULT_SETTINGS,
  ...overrides,
})

describe('permissions', () => {
  it('lets readers participate unless the repository disallows it', () => {
    expect(allowed('issue:create', subject())).toBe(true)
    expect(allowed('comment:create', subject())).toBe(true)
    expect(allowed('pull:create', subject())).toBe(true)
    const closed = { ...DEFAULT_SETTINGS, readCanParticipate: false }
    expect(allowed('issue:create', subject({ settings: closed }))).toBe(false)
    expect(allowed('comment:create', subject({ settings: closed }))).toBe(false)
    expect(allowed('issue:create', subject({ access: 'triage', settings: closed }))).toBe(true)
  })

  it('follows GitHub roles for triage, write, maintain and admin', () => {
    expect(allowed('issue:triage', subject())).toBe(false)
    expect(allowed('issue:triage', subject({ access: 'triage' }))).toBe(true)
    expect(allowed('label:manage', subject({ access: 'triage' }))).toBe(false)
    expect(allowed('label:manage', subject({ access: 'write' }))).toBe(true)
    expect(allowed('pull:merge', subject({ access: 'triage' }))).toBe(false)
    expect(allowed('pull:merge', subject({ access: 'write' }))).toBe(true)
    expect(allowed('discussion:category', subject({ access: 'write' }))).toBe(false)
    expect(allowed('discussion:category', subject({ access: 'maintain' }))).toBe(true)
    expect(allowed('settings:manage', subject({ access: 'maintain' }))).toBe(false)
    expect(allowed('settings:manage', subject({ access: 'admin' }))).toBe(true)
  })

  it('lets authors edit and close their own items', () => {
    expect(allowed('issue:edit', subject())).toBe(false)
    expect(allowed('issue:edit', subject({ isAuthor: true }))).toBe(true)
    expect(allowed('issue:close', subject({ isAuthor: true }))).toBe(true)
    expect(allowed('comment:edit', subject({ isAuthor: true }))).toBe(true)
    expect(allowed('comment:edit', subject({ access: 'triage' }))).toBe(false)
    expect(allowed('comment:edit', subject({ access: 'write' }))).toBe(true)
  })

  it('blocks locked conversations for everyone below write', () => {
    expect(allowed('comment:create', subject({ locked: true }))).toBe(false)
    expect(allowed('comment:create', subject({ access: 'triage', locked: true }))).toBe(false)
    expect(allowed('comment:create', subject({ access: 'write', locked: true }))).toBe(true)
  })

  it('never lets anonymous, read-only tokens or users without access mutate', () => {
    expect(allowed('view', subject({ authenticated: false }))).toBe(true)
    expect(allowed('comment:create', subject({ authenticated: false }))).toBe(false)
    expect(allowed('comment:create', subject({ access: 'admin', writable: false }))).toBe(false)
    expect(allowed('view', subject({ access: 'none' }))).toBe(false)
  })

  it('respects disabled features', () => {
    expect(allowed('issue:create', subject({ access: 'admin', settings: { ...DEFAULT_SETTINGS, hasIssues: false } }))).toBe(false)
    expect(allowed('discussion:create', subject({ access: 'admin', settings: { ...DEFAULT_SETTINGS, hasDiscussions: false } }))).toBe(false)
  })
})

describe('references', () => {
  it('finds #N references outside code', () => {
    expect(parseReferences('See #1, #2 and acme/site#3; not a#4 or &#5;\n```\n#6\n```\n`#7` (#8)')).toEqual([
      { owner: null, repo: null, number: 1 },
      { owner: null, repo: null, number: 2 },
      { owner: 'acme', repo: 'site', number: 3 },
      { owner: null, repo: null, number: 8 },
    ])
    expect(stripCode('a `b` c')).toBe('a   c')
  })

  it('finds closing keywords like GitHub', () => {
    const text = 'Fixes #1, closes: #2\nResolved acme/site#3 and resolves other/repo#4. Mentions #5. fixing #6'
    expect(parseClosingReferences(text).map((reference) => reference.number)).toEqual([1, 2, 3, 4])
    expect(localNumbers(parseClosingReferences(text), { owner: 'ACME', name: 'site' })).toEqual([1, 2, 3])
    expect(parseClosingReferences('`fixes #9`')).toEqual([])
  })
})
