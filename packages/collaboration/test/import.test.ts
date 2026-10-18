import { describe, expect, it } from 'vitest'
import { CollaborationError, createIssue, getIssue, importComment, importIssue, listComments, mapImportedUser } from '../src/index.ts'
import { createFixture } from './fixture.ts'

const at = Date.parse('2020-01-02T03:04:05Z')

describe('import', () => {
  it('keeps numbers, authors and times, shows unmapped users by login and needs admin', async () => {
    const fixture = await createFixture()
    const alice = await fixture.scope('alice')
    const bob = await fixture.scope('bob')
    const stranger = await mapImportedUser(alice, 'stranger')
    expect(await mapImportedUser(alice, 'gh-bob', 'bob@example.org')).toEqual({ login: 'gh-bob', ref: { kind: 'user', id: fixture.users.bob.id } })
    const issue = {
      source: 'issue:7',
      url: 'https://github.com/acme/site/issues/7',
      author: stranger,
      createdAt: at,
      updatedAt: at,
      number: 7,
      title: 'Imported',
      body: 'See #3',
      state: 'closed' as const,
      stateReason: 'completed' as const,
      locked: false,
      lockReason: null,
      labels: [],
      assignees: [await mapImportedUser(alice, 'carol'), stranger],
      milestone: null,
      closedAt: at,
    }
    await expect(importIssue(bob, issue)).rejects.toBeInstanceOf(CollaborationError)
    expect(await importIssue(alice, issue)).toBe('imported')
    expect(await importIssue(alice, issue)).toBe('exists')
    expect(await importIssue(alice, { ...issue, source: 'issue:other' })).toBe('taken')
    expect(await getIssue(alice, 7)).toMatchObject({ number: 7, author: { id: null, login: 'stranger' }, createdAt: at, closedAt: at, assignees: [{ login: 'carol' }, { id: null, login: 'stranger' }] })
    expect((await createIssue(alice, { title: 'next' })).number).toBe(8)
    const comment = { source: 'comment:1', url: null, author: stranger, createdAt: at, updatedAt: at, body: 'hi' }
    expect(await importComment(alice, 7, comment)).toBe(true)
    expect(await importComment(alice, 7, comment)).toBe(false)
    expect(await importComment(alice, 8, { ...comment, source: 'comment:2' })).toBe(false)
    expect((await listComments(alice, 7)).items).toMatchObject([{ author: { login: 'stranger' }, body: 'hi', createdAt: at }])
  })
})
