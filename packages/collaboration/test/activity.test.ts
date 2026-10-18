import { describe, expect, it } from 'vitest'
import {
  type Activity,
  changeRequestedReviewers,
  createComment,
  createIssue,
  createPull,
  createReview,
  createReviewComment,
  mergePull,
  openRepository,
  updateIssue,
} from '../src/index.ts'
import { createFixture } from './fixture.ts'

describe('activity hook', () => {
  it('reports issue, comment, pull request and review activity for notifications', async () => {
    const fixture = await createFixture()
    const seen: Activity[] = []
    const options = { ...fixture.options, onActivity: async (_: unknown, activity: Activity) => void seen.push(activity) }
    const as = (user: 'alice' | 'bob' | 'carol') => openRepository(options, fixture.users[user].principal, 'alice', 'site')
    const bob = await as('bob')
    await createIssue(bob, { title: 'Broken' })
    await createComment(await as('carol'), 1, 'Same here')
    await updateIssue(bob, 1, { title: 'Broken badly', labels: [] })
    await createPull(await as('carol'), { title: 'Docs', head: 'feature', base: 'main' })
    await changeRequestedReviewers(bob, 2, ['alice'], 'add')
    await createReviewComment(bob, 2, { body: 'Nice', path: 'README.md', line: 16 })
    await createReview(await as('alice'), 2, { event: 'APPROVE' })
    await mergePull(bob, 2)
    expect(seen.map((activity) => [activity.kind, activity.action, activity.number])).toEqual([
      ['issues', 'opened', 1],
      ['issue_comment', 'created', 1],
      ['issues', 'edited', 1],
      ['pull_request', 'opened', 2],
      ['pull_request', 'review_requested', 2],
      ['pull_request_review_comment', 'created', 2],
      ['pull_request_review', 'submitted', 2],
      ['pull_request', 'closed', 2],
      ['issues', 'closed', 1],
    ])
    expect(seen[0]!.actor).toEqual({ kind: 'user', id: fixture.users.bob.id })
    expect(seen[2]!.changes).toEqual({ title: { from: 'Broken' } })
    expect(seen[4]!.requestedReviewer).toBe('alice')
  })
})
