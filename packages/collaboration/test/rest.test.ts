import { describe, expect, it } from 'vitest'
import { handleCollaborationApi } from '../src/index.ts'
import { createFixture, type Fixture } from './fixture.ts'

const BASE = 'https://forge.example'

type Json = Record<string, any>

const api = (fixture: Fixture) => async (method: string, path: string, user?: 'alice' | 'bob' | 'carol' | 'dave' | 'erin', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await handleCollaborationApi(
    new Request(`${BASE}/api/v3${path}`, {
      method,
      headers: { ...(user ? { Authorization: `token ${fixture.users[user].token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    { ...fixture.options, publicUrl: BASE },
  )
  if (!response) return { status: 0, body: null as unknown as Json, headers: new Headers(), text: '' }
  const text = await response.text()
  let parsed: unknown = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed as Json, headers: response.headers, text }
}

describe('REST API /api/v3', () => {
  it('leaves foreign routes to other handlers and authenticates', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    expect((await call('GET', '/repos/alice/site/actions/runners', 'alice')).status).toBe(0)
    expect((await call('GET', '/meta')).status).toBe(0)
    expect((await call('GET', '/repos/alice/site/issues')).status).toBe(404)
    expect((await call('GET', '/repos/alice/site/issues', 'erin')).status).toBe(404)
    const bad = await handleCollaborationApi(new Request(`${BASE}/api/v3/repos/alice/site/issues`, { headers: { Authorization: 'token gfp_nope' } }), fixture.options)
    expect(bad?.status).toBe(401)
    expect((await call('DELETE', '/repos/alice/site/issues', 'alice')).status).toBe(405)
    const repo = await call('GET', '/repos/alice/site', 'carol')
    expect(repo.body).toMatchObject({ full_name: 'alice/site', private: true, default_branch: 'main', has_issues: true, permissions: { pull: true, triage: false, push: false, admin: false } })
    expect((await call('PATCH', '/repos/alice/site', 'bob', { has_discussions: false })).status).toBe(403)
    expect((await call('PATCH', '/repos/alice/site', 'alice', { has_discussions: false, allow_squash_merge: false })).body).toMatchObject({ has_discussions: false, allow_squash_merge: false })
    expect((await call('GET', '/repos/alice/site/discussions', 'alice')).status).toBe(410)
  })

  it('speaks GitHub shapes for issues, labels, milestones and comments', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    expect((await call('POST', '/repos/alice/site/labels', 'bob', { name: 'bug', color: 'd73a4a', description: 'Broken' })).body).toMatchObject({ name: 'bug', color: 'd73a4a', default: false })
    expect((await call('POST', '/repos/alice/site/milestones', 'bob', { title: 'v1', due_on: '2026-12-24T00:00:00Z' })).body).toMatchObject({ number: 1, title: 'v1', due_on: '2026-12-24T00:00:00Z', open_issues: 0 })
    const created = await call('POST', '/repos/alice/site/issues', 'bob', { title: 'Crash', body: 'It *crashes*', labels: ['bug'], assignees: ['carol'], milestone: 1 })
    expect(created.status).toBe(201)
    expect(created.headers.get('Location')).toBe(`${BASE}/api/v3/repos/alice/site/issues/1`)
    expect(created.body).toMatchObject({
      number: 1,
      title: 'Crash',
      body: 'It *crashes*',
      state: 'open',
      user: { login: 'bob', type: 'User' },
      labels: [{ name: 'bug' }],
      assignee: { login: 'carol' },
      assignees: [{ login: 'carol' }],
      milestone: { number: 1, open_issues: 1 },
      comments: 0,
      html_url: `${BASE}/alice/site/issues/1`,
      url: `${BASE}/api/v3/repos/alice/site/issues/1`,
      created_at: '2026-10-18T12:00:00Z',
    })
    for (let i = 0; i < 3; i++) await call('POST', '/repos/alice/site/issues/1/comments', 'carol', { body: `comment ${i}` })
    const page = await call('GET', '/repos/alice/site/issues/1/comments?per_page=2', 'carol')
    expect(page.body.map((comment: Json) => comment.body)).toEqual(['comment 0', 'comment 1'])
    expect(page.headers.get('Link')).toBe(
      `<${BASE}/api/v3/repos/alice/site/issues/1/comments?per_page=2&page=2>; rel="next", <${BASE}/api/v3/repos/alice/site/issues/1/comments?per_page=2&page=2>; rel="last"`,
    )
    const commentId = page.body[0].id
    expect((await call('PATCH', `/repos/alice/site/issues/comments/${commentId}`, 'dave', { body: 'nope' })).status).toBe(403)
    expect((await call('PATCH', `/repos/alice/site/issues/comments/${commentId}`, 'carol', { body: 'edited' })).body).toMatchObject({ body: 'edited', id: commentId })
    expect((await call('DELETE', `/repos/alice/site/issues/comments/${commentId}`, 'bob')).status).toBe(204)
    expect((await call('PATCH', '/repos/alice/site/issues/1', 'dave', { state: 'closed', state_reason: 'not_planned', labels: [] })).body).toMatchObject({ state: 'closed', state_reason: 'not_planned', labels: [], closed_by: { login: 'dave' }, comments: 2 })
    expect((await call('PUT', '/repos/alice/site/issues/1/labels', 'dave', { labels: ['bug', 'new-one'] })).status).toBe(422)
    expect((await call('PUT', '/repos/alice/site/issues/1/labels', 'bob', { labels: ['bug', 'new-one'] })).body.map((label: Json) => label.name)).toEqual(['bug', 'new-one'])
    expect((await call('DELETE', '/repos/alice/site/issues/1/labels/new-one', 'dave')).body.map((label: Json) => label.name)).toEqual(['bug'])
    expect((await call('PUT', '/repos/alice/site/issues/1/lock', 'dave', { lock_reason: 'resolved' })).status).toBe(204)
    expect((await call('GET', '/repos/alice/site/issues/1', 'carol')).body).toMatchObject({ locked: true, active_lock_reason: 'resolved' })
    const events = (await call('GET', '/repos/alice/site/issues/1/events', 'carol')).body.map((event: Json) => event.event)
    expect(events).toEqual(['labeled', 'assigned', 'milestoned', 'closed', 'unlabeled', 'labeled', 'labeled', 'unlabeled', 'locked'])
    const timeline = (await call('GET', '/repos/alice/site/issues/1/timeline', 'carol')).body.map((item: Json) => item.event)
    expect(timeline.filter((event: string) => event === 'commented')).toHaveLength(2)
    expect((await call('GET', '/repos/alice/site/issues?state=closed&labels=bug', 'carol')).body.map((issue: Json) => issue.number)).toEqual([1])
    expect((await call('GET', '/repos/alice/site/issues?state=open', 'carol')).body).toEqual([])
  })

  it('creates, reviews and merges pull requests', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    const created = await call('POST', '/repos/alice/site/pulls', 'carol', { title: 'Add docs', body: 'Docs', head: 'feature', base: 'main' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      number: 1,
      state: 'open',
      draft: false,
      merged: false,
      mergeable: true,
      mergeable_state: 'clean',
      head: { ref: 'feature', sha: fixture.rev('feature'), label: 'alice:feature' },
      base: { ref: 'main', sha: fixture.rev('main') },
      commits: 1,
      changed_files: 2,
      user: { login: 'carol' },
    })
    expect((await call('GET', '/repos/alice/site/issues/1', 'carol')).body.pull_request).toMatchObject({ url: `${BASE}/api/v3/repos/alice/site/pulls/1`, merged_at: null })
    const files = (await call('GET', '/repos/alice/site/pulls/1/files', 'carol')).body
    expect(files.map((file: Json) => [file.filename, file.status, file.changes])).toEqual([
      ['README.md', 'modified', 2],
      ['docs/new.md', 'added', 1],
    ])
    expect(files[1].patch).toBe('@@ -0,0 +1 @@\n+new docs')
    const diff = await call('GET', '/repos/alice/site/pulls/1', 'carol', undefined, { Accept: 'application/vnd.github.v3.diff' })
    expect(diff.text).toMatch(/^diff --git a\/README.md b\/README.md\n/)
    expect((await call('GET', '/repos/alice/site/pulls/1/commits', 'carol')).body[0]).toMatchObject({ sha: fixture.rev('feature'), commit: { message: 'feature: docs\n\nFixes #1', author: { name: 'Test', date: '2026-01-01T00:00:00Z' } } })
    const review = await call('POST', '/repos/alice/site/pulls/1/reviews', 'bob', { event: 'REQUEST_CHANGES', body: 'Fix the line', comments: [{ path: 'README.md', line: 16, body: 'This one' }] })
    expect(review.body).toMatchObject({ state: 'CHANGES_REQUESTED', user: { login: 'bob' }, commit_id: fixture.rev('feature') })
    const comments = (await call('GET', '/repos/alice/site/pulls/1/comments', 'carol')).body
    expect(comments[0]).toMatchObject({ path: 'README.md', line: 16, side: 'RIGHT', pull_request_review_id: review.body.id, commit_id: fixture.rev('feature'), body: 'This one' })
    const reply = await call('POST', `/repos/alice/site/pulls/1/comments/${comments[0].id}/replies`, 'carol', { body: 'Done' })
    expect(reply.body).toMatchObject({ in_reply_to_id: comments[0].id, line: 16 })
    expect((await call('POST', '/repos/alice/site/pulls/1/requested_reviewers', 'dave', { reviewers: ['alice'] })).body.requested_reviewers.map((user: Json) => user.login)).toEqual(['alice'])
    expect((await call('PUT', `/repos/alice/site/pulls/1/reviews/${review.body.id}/dismissals`, 'bob', { message: 'Fixed', event: 'DISMISS' })).body.state).toBe('DISMISSED')
    expect((await call('POST', '/repos/alice/site/pulls/1/reviews', 'alice', { event: 'APPROVE' })).body.state).toBe('APPROVED')
    expect((await call('GET', '/repos/alice/site/pulls/1/requested_reviewers', 'carol')).body.users).toEqual([])
    expect((await call('GET', '/repos/alice/site/pulls/1/merge', 'carol')).status).toBe(404)
    expect((await call('PUT', '/repos/alice/site/pulls/1/merge', 'carol', {})).status).toBe(403)
    expect((await call('PUT', '/repos/alice/site/pulls/1/merge', 'bob', { merge_method: 'fast-forward' })).status).toBe(422)
    const merged = await call('PUT', '/repos/alice/site/pulls/1/merge', 'bob', { merge_method: 'squash', commit_title: 'Docs (#1)', sha: fixture.rev('feature') })
    expect(merged.body).toMatchObject({ merged: true, message: 'Pull Request successfully merged', sha: expect.stringMatching(/^[0-9a-f]{40}$/) })
    expect((await call('GET', '/repos/alice/site/pulls/1/merge', 'carol')).status).toBe(204)
    expect((await call('GET', '/repos/alice/site/pulls/1', 'carol')).body).toMatchObject({ merged: true, state: 'closed', merge_commit_sha: merged.body.sha, merged_by: { login: 'bob' } })
    expect((await call('GET', '/repos/alice/site/pulls?state=closed', 'carol')).body.map((pull: Json) => pull.number)).toEqual([1])
  })

  it('stores commit statuses and check runs', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    const sha = fixture.rev('main')
    expect((await call('POST', `/repos/alice/site/statuses/${sha}`, 'carol', { state: 'success' })).status).toBe(403)
    expect((await call('POST', `/repos/alice/site/statuses/${'0'.repeat(40)}`, 'bob', { state: 'success' })).status).toBe(422)
    expect((await call('POST', `/repos/alice/site/statuses/${sha}`, 'bob', { state: 'bogus' })).status).toBe(422)
    await call('POST', `/repos/alice/site/statuses/${sha}`, 'bob', { state: 'pending', context: 'ci/build', target_url: 'https://ci.example/1' })
    await call('POST', `/repos/alice/site/statuses/${sha}`, 'bob', { state: 'success', context: 'ci/build', description: 'Build passed' })
    await call('POST', `/repos/alice/site/statuses/${sha}`, 'bob', { state: 'success', context: 'lint' })
    const combined = await call('GET', '/repos/alice/site/commits/main/status', 'carol')
    expect(combined.body).toMatchObject({ state: 'success', sha, total_count: 2, statuses: [{ context: 'ci/build', state: 'success', description: 'Build passed' }, { context: 'lint' }] })
    expect((await call('GET', `/repos/alice/site/commits/${sha}/statuses`, 'carol')).body.map((status: Json) => status.state)).toEqual(['success', 'success', 'pending'])
    const run = await call('POST', '/repos/alice/site/check-runs', 'bob', { name: 'test', head_sha: sha, status: 'in_progress', output: { title: 'Running', summary: 'Tests are running' } })
    expect(run.body).toMatchObject({ name: 'test', status: 'in_progress', conclusion: null, started_at: '2026-10-18T12:00:00Z', output: { title: 'Running' } })
    expect((await call('PATCH', `/repos/alice/site/check-runs/${run.body.id}`, 'bob', { status: 'completed' })).status).toBe(422)
    expect((await call('PATCH', `/repos/alice/site/check-runs/${run.body.id}`, 'bob', { conclusion: 'failure' })).body).toMatchObject({ status: 'completed', conclusion: 'failure', output: { title: 'Running' } })
    const listed = await call('GET', '/repos/alice/site/commits/main/check-runs', 'carol')
    expect(listed.body).toMatchObject({ total_count: 1, check_runs: [{ name: 'test', conclusion: 'failure' }] })
  })

  it('runs discussions with categories and answers', async () => {
    const fixture = await createFixture()
    const call = api(fixture)
    expect((await call('GET', '/repos/alice/site/discussion-categories', 'carol')).body.map((category: Json) => [category.slug, category.is_answerable])).toEqual([
      ['general', false],
      ['q-a', true],
      ['ideas', false],
      ['announcements', false],
    ])
    expect((await call('POST', '/repos/alice/site/discussion-categories', 'bob', { name: 'Help' })).status).toBe(403)
    expect((await call('POST', '/repos/alice/site/discussion-categories', 'alice', { name: 'Show and tell', emoji: ':raised_hands:' })).body).toMatchObject({ slug: 'show-and-tell' })
    expect((await call('POST', '/repos/alice/site/discussions', 'carol', { title: 'News', body: 'x', category: 'announcements' })).status).toBe(403)
    const discussion = await call('POST', '/repos/alice/site/discussions', 'carol', { title: 'How do I clone?', body: 'Help please', category: 'q-a' })
    expect(discussion.body).toMatchObject({ number: 1, category: { slug: 'q-a' }, user: { login: 'carol' }, answer_comment_id: null })
    const answer = await call('POST', '/repos/alice/site/discussions/1/comments', 'bob', { body: 'Use git clone' })
    const reply = await call('POST', '/repos/alice/site/discussions/1/comments', 'carol', { body: 'Thanks', reply_to_id: answer.body.id })
    expect(reply.body).toMatchObject({ parent_id: answer.body.id })
    expect((await call('PUT', '/repos/alice/site/discussions/1/answer', 'dave', { comment_id: reply.body.id })).status).toBe(422)
    expect((await call('PUT', '/repos/alice/site/discussions/1/answer', 'carol', { comment_id: answer.body.id })).body).toMatchObject({ answer_comment_id: answer.body.id, answer_chosen_by: { login: 'carol' } })
    expect((await call('GET', '/repos/alice/site/discussions/1/comments', 'carol')).body.map((comment: Json) => [comment.body, comment.is_answer, comment.child_comment_count])).toEqual([
      ['Use git clone', true, 1],
      ['Thanks', false, 0],
    ])
    expect((await call('PATCH', '/repos/alice/site/discussions/1', 'carol', { state: 'closed' })).body).toMatchObject({ state: 'closed', state_reason: 'resolved' })
    expect((await call('PUT', '/repos/alice/site/discussions/1/lock', 'dave')).body.locked).toBe(true)
    expect((await call('POST', '/repos/alice/site/discussions/1/comments', 'carol', { body: 'more' })).status).toBe(403)
    expect((await call('POST', '/repos/alice/site/issues', 'carol', { title: 'after discussion' })).body.number).toBe(2)
    expect((await call('GET', '/repos/alice/site/discussions?answered=true', 'carol')).body.map((entry: Json) => entry.number)).toEqual([1])
  })

  it('serves public repositories to anonymous readers but never lets them write', async () => {
    const fixture = await createFixture({ visibility: 'public' })
    const call = api(fixture)
    await call('POST', '/repos/alice/site/issues', 'erin', { title: 'From a stranger' })
    expect((await call('GET', '/repos/alice/site/issues')).body.map((issue: Json) => issue.title)).toEqual(['From a stranger'])
    expect((await call('POST', '/repos/alice/site/issues', undefined, { title: 'anonymous' })).status).toBe(401)
    expect((await call('POST', '/repos/alice/site/issues/1/comments', 'erin', { body: 'me too' })).status).toBe(201)
  })
})
