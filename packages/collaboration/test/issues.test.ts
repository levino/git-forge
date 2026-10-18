import { describe, expect, it } from 'vitest'
import {
  changeAssignees,
  changeIssueLabels,
  CollaborationError,
  createComment,
  createDiscussion,
  createIssue,
  createLabel,
  createMilestone,
  createPull,
  deleteComment,
  deleteLabel,
  getIssue,
  getMilestone,
  listComments,
  listEvents,
  listIssues,
  listLabels,
  setLocked,
  timeline,
  updateComment,
  updateIssue,
  updateSettings,
} from '../src/index.ts'
import { createFixture } from './fixture.ts'

const fails = async (promise: Promise<unknown>, status: number) => {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CollaborationError)
  expect((error as CollaborationError).status).toBe(status)
}

describe('issues', () => {
  it('numbers issues, pull requests and discussions in one sequence per repository', async () => {
    const fixture = await createFixture()
    const alice = await fixture.scope('alice')
    expect((await createIssue(alice, { title: 'first' })).number).toBe(1)
    expect((await createPull(alice, { title: 'pull', head: 'feature', base: 'main' })).number).toBe(2)
    expect((await createDiscussion(alice, { title: 'talk', body: 'hello', category: 'general' })).number).toBe(3)
    expect((await createIssue(alice, { title: 'second' })).number).toBe(4)
    expect((await listIssues(alice, { state: 'all' })).items.map((issue) => [issue.number, issue.isPull])).toEqual([
      [4, false],
      [2, true],
      [1, false],
    ])
    expect((await listIssues(alice, { kind: 'issue' })).total).toBe(2)
  })

  it('stores Markdown raw and records title changes, state changes and cross references', async () => {
    const fixture = await createFixture()
    const carol = await fixture.scope('carol')
    const first = await createIssue(carol, { title: 'Broken', body: '**bold** <script>x</script>' })
    expect(first.body).toBe('**bold** <script>x</script>')
    expect(first.author.login).toBe('carol')
    const second = await createIssue(carol, { title: 'Related', body: 'See #1 and #99' })
    await createComment(carol, second.number, 'Again #1')
    await updateIssue(carol, first.number, { title: 'Broken badly' })
    await updateIssue(carol, first.number, { state: 'closed', stateReason: 'not_planned' })
    const closed = await getIssue(carol, first.number)
    expect(closed).toMatchObject({ state: 'closed', stateReason: 'not_planned', closedBy: { login: 'carol' } })
    await updateIssue(carol, first.number, { state: 'open' })
    expect((await getIssue(carol, first.number)).stateReason).toBe('reopened')
    expect((await listEvents(carol, first.number)).map((event) => [event.event, event.data])).toEqual([
      ['cross-referenced', { source: { type: 'issue', number: 2 } }],
      ['cross-referenced', { source: { type: 'issue', number: 2, comment_id: 1 } }],
      ['renamed', { rename: { from: 'Broken', to: 'Broken badly' } }],
      ['closed', { state_reason: 'not_planned' }],
      ['reopened', {}],
    ])
  })

  it('applies GitHub permissions to issues and comments', async () => {
    const fixture = await createFixture()
    const [alice, bob, carol, dave] = [await fixture.scope('alice'), await fixture.scope('bob'), await fixture.scope('carol'), await fixture.scope('dave')]
    await fails(fixture.scope('anonymous'), 404)
    await fails(fixture.scope('erin'), 404)
    const issue = await createIssue(carol, { title: 'mine', labels: ['bug'], assignees: ['bob'] })
    expect(issue.labels).toEqual([])
    expect(issue.assignees).toEqual([])
    await fails(updateIssue(dave, issue.number, { title: 'not yours' }), 403)
    await updateIssue(bob, issue.number, { title: 'writers may edit' })
    await updateIssue(carol, issue.number, { state: 'closed' })
    await updateIssue(carol, issue.number, { state: 'open' })
    const foreign = await createIssue(alice, { title: 'not carols' })
    await fails(updateIssue(carol, foreign.number, { state: 'closed' }), 403)
    await updateIssue(dave, foreign.number, { state: 'closed' })
    await fails(createLabel(dave, { name: 'bug' }), 403)
    await createLabel(bob, { name: 'bug', color: '#D73A4A', description: 'Something is broken' })
    expect((await changeIssueLabels(dave, issue.number, ['bug'], 'add')).map((label) => label.name)).toEqual(['bug'])
    await fails(changeIssueLabels(carol, issue.number, ['bug'], 'remove'), 403)
    await fails(changeIssueLabels(dave, issue.number, ['unknown'], 'add'), 422)
    expect((await changeIssueLabels(bob, issue.number, ['feature'], 'add')).map((label) => label.name)).toEqual(['bug', 'feature'])
    expect((await changeAssignees(dave, issue.number, ['bob', 'carol'], 'add')).assignees.map((user) => user.login)).toEqual(['bob', 'carol'])
    await fails(changeAssignees(dave, issue.number, ['erin'], 'add'), 422)
    const comment = await createComment(carol, issue.number, 'a comment')
    await fails(updateComment(dave, comment.id, 'edited by triage'), 403)
    expect((await updateComment(carol, comment.id, 'edited by me')).body).toBe('edited by me')
    await setLocked(dave, issue.number, true, 'too heated')
    await fails(createComment(carol, issue.number, 'locked out'), 403)
    await fails(createComment(dave, issue.number, 'triage is locked out too'), 403)
    await createComment(bob, issue.number, 'writers still talk')
    await deleteComment(bob, comment.id)
    expect((await listComments(alice, issue.number)).items.map((entry) => entry.body)).toEqual(['writers still talk'])
    expect((await getIssue(alice, issue.number)).comments).toBe(1)
    await updateSettings(alice, { readCanParticipate: false })
    await fails(createIssue(await fixture.scope('carol'), { title: 'closed shop' }), 403)
    await updateSettings(alice, { hasIssues: false })
    await fails(createIssue(await fixture.scope('alice'), { title: 'disabled' }), 403)
  })

  it('filters by labels, assignee, creator and milestone and manages milestones and labels', async () => {
    const fixture = await createFixture()
    const alice = await fixture.scope('alice')
    await createLabel(alice, { name: 'bug' })
    const milestone = await createMilestone(alice, { title: 'v1', dueOn: '2026-12-01T00:00:00Z' })
    expect(milestone.number).toBe(1)
    await createIssue(alice, { title: 'a', labels: ['bug'], assignees: ['bob'], milestone: 1 })
    await createIssue(alice, { title: 'b' })
    const c = await createIssue(await fixture.scope('carol'), { title: 'c' })
    expect((await listIssues(alice, { labels: ['bug'] })).items.map((issue) => issue.title)).toEqual(['a'])
    expect((await listIssues(alice, { assignee: 'bob' })).items.map((issue) => issue.title)).toEqual(['a'])
    expect((await listIssues(alice, { assignee: 'none' })).items.map((issue) => issue.title)).toEqual(['c', 'b'])
    expect((await listIssues(alice, { creator: 'carol' })).items.map((issue) => issue.title)).toEqual(['c'])
    expect((await listIssues(alice, { milestone: '1' })).items.map((issue) => issue.title)).toEqual(['a'])
    expect((await listIssues(alice, { milestone: 'none', sort: 'created', direction: 'asc' }, { page: 1, perPage: 1 })).items.map((issue) => issue.title)).toEqual(['b'])
    await updateIssue(alice, c.number, { milestone: 1, state: 'closed' })
    expect(await getMilestone(alice, 1)).toMatchObject({ openIssues: 1, closedIssues: 1, title: 'v1' })
    await deleteLabel(alice, 'bug')
    expect((await listLabels(alice)).items).toEqual([])
    expect((await getIssue(alice, 1)).labels).toEqual([])
    const events = (await timeline(alice, 1)).map((item) => (item.kind === 'event' ? item.event.event : item.kind))
    expect(events).toEqual(['labeled', 'assigned', 'milestoned'])
  })
})
