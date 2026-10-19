import { describe, expect, it } from 'vitest'
import { installationNeeds, missingPermission } from '../src/index.ts'

const needs = (method: string, path: string, operation: string | null = null) => installationNeeds(method, new URL(`https://forge.example${path}`), operation)

describe('installation permission table', () => {
  it('maps routes and Git surfaces to permissions and denies the rest', () => {
    expect(needs('POST', '/api/v3/repos/o/r/issues')).toEqual([['issues', 'write']])
    expect(needs('GET', '/api/repos/o/r/labels')).toEqual([['issues', 'read']])
    expect(needs('PUT', '/api/v3/repos/o/r/pulls/3/merge')).toEqual([['pull_requests', 'write'], ['contents', 'write']])
    expect(needs('PUT', '/api/v3/repos/o/r/contents/a.txt')).toEqual([['contents', 'write']])
    expect(needs('GET', '/api/v3/repos/o/r/commits/abc/check-runs')).toEqual([['checks', 'read']])
    expect(needs('DELETE', '/api/v3/repos/o/r')).toEqual([['administration', 'write']])
    expect(needs('GET', '/o/r.git/info/refs?service=git-receive-pack')).toEqual([['contents', 'write']])
    expect(needs('POST', '/o/r.git/git-upload-pack')).toEqual([['contents', 'read']])
    expect(needs('POST', '/o/r.git/info/lfs/objects/batch', 'upload')).toEqual([['contents', 'write']])
    expect(needs('GET', '/api/v3/installation/repositories')).toEqual([])
    expect(needs('GET', '/api/v3/repos/o/r/subscription')).toBeNull()
    expect(needs('GET', '/o/r/issues')).toBeNull()
    expect(missingPermission({ metadata: 'read', issues: 'write' }, needs('GET', '/api/v3/repos/o/r'))).toBeNull()
    expect(missingPermission({ issues: 'write' }, needs('POST', '/o/r.git/git-receive-pack'))).toContain('contents: write')
    expect(missingPermission({ contents: 'write' }, needs('GET', '/api/v3/notifications'))).toContain('not available')
  })
})
