import { describe, expect, it } from 'vitest'
import { CollaborationError, createIssue, getIssue, importComment, importIssue, importReview, listComments, mapImportedUser, pullRow, reviewEvidence } from '../src/index.ts'
import { createFixture } from './fixture.ts'

const at = Date.parse('2020-01-02T03:04:05Z')

describe('import', () => {
  it('keeps numbers, authors and times, shows unmapped users by login and needs admin', async () => {
    const fixture = await createFixture()
    const alice = await fixture.scope('alice')
    const bob = await fixture.scope('bob')
    const stranger = await mapImportedUser(alice, 'stranger', true)
    expect(await mapImportedUser(alice, 'bob', true)).toEqual({ login: 'bob', ref: { kind: 'user', id: fixture.users.bob.id } })
    expect(await mapImportedUser(alice, 'bob', false)).toEqual({ login: 'bob', ref: null })
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
      assignees: [await mapImportedUser(alice, 'carol', true), stranger],
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

  it('does not count imported reviews as approvals', async () => {
    const fixture = await createFixture()
    const alice = await fixture.scope('alice')
    const author = await mapImportedUser(alice, 'stranger', true)
    const head = fixture.rev('feature')
    const pull = { headRef: 'feature', baseRef: 'main', headSha: head, baseSha: fixture.rev('main'), draft: false, mergedAt: null, mergeCommitSha: null }
    const base = { url: null, author, createdAt: at, updatedAt: at, title: 'Imported', body: null, state: 'open' as const, stateReason: null, locked: false, lockReason: null, labels: [], assignees: [], milestone: null, closedAt: null }
    expect(await importIssue(alice, { ...base, source: 'pull:9', number: 9, pull })).toBe('imported')
    const reviewer = await mapImportedUser(alice, 'bob', true)
    expect(await importReview(alice, 9, { source: 'review:1', url: null, author: reviewer, createdAt: at, updatedAt: at, state: 'APPROVED', body: null, commitId: head })).toBe(true)
    expect(await reviewEvidence(alice, await pullRow(alice, 9))).toMatchObject({ approvals: 0, lastPushApproved: false })
  })
})
