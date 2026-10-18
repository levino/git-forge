import { createMemoryEmailSender } from '@git-forge/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootstrap, call, type NodeForge, nodeForge } from '../support/node-forge.ts'

const BASE = 'https://forge.example'

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T

let forge: NodeForge
let ada: string
let bob: string
let carol: string

const tokenFor = async (login: string, scopes: string[] = ['repo:admin']): Promise<string> => {
  expect((await call(forge, BASE, 'POST', '/api/admin/users', ada, { login })).status).toBe(201)
  return (await json<{ token: string }>(await call(forge, BASE, 'POST', `/api/admin/users/${login}/tokens`, ada, { scopes }))).token
}

beforeAll(async () => {
  forge = await nodeForge()
  ada = await bootstrap(forge, BASE, 'ada')
  bob = await tokenFor('bob')
  carol = await tokenFor('carol', ['repo:write'])
})

describe('organizations API', () => {
  it('creates organizations and manages people on the same operations as the pages', async () => {
    expect((await call(forge, BASE, 'POST', '/api/orgs', undefined, { login: 'guild' })).status).toBe(401)
    expect((await call(forge, BASE, 'POST', '/api/orgs', carol, { login: 'guild' })).status).toBe(403)
    expect((await call(forge, BASE, 'POST', '/api/orgs', bob, { login: 'explore' })).status).toBe(422)
    expect(await json(await call(forge, BASE, 'POST', '/api/orgs', bob, { login: 'guild' }))).toMatchObject({ login: 'guild' })
    expect((await call(forge, BASE, 'POST', '/api/orgs', bob, { login: 'guild' })).status).toBe(409)
    expect((await call(forge, BASE, 'GET', '/api/orgs/guild', carol)).status).toBe(404)
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/members/carol', bob, { role: 'member' })).status).toBe(204)
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/members/carol', bob, { role: 'boss' })).status).toBe(422)
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/members/bob', bob, { role: 'member' })).status).toBe(422)
    const view = await json<{ membership: string; members: { login: string; role: string }[] }>(await call(forge, BASE, 'GET', '/api/orgs/guild', carol))
    expect(view.membership).toBe('member')
    expect(view.members.map((member) => `${member.login}:${member.role}`)).toEqual(['bob:owner', 'carol:member'])
    expect((await call(forge, BASE, 'DELETE', '/api/orgs/guild/members/bob', carol)).status).toBe(403)
  })

  it('manages teams, their members and repository roles', async () => {
    expect((await call(forge, BASE, 'POST', '/api/repos', ada, { owner: 'guild', name: 'site' })).status).toBe(201)
    expect(await json(await call(forge, BASE, 'POST', '/api/orgs/guild/teams', bob, { slug: 'web', name: 'Web' }))).toMatchObject({ slug: 'web', name: 'Web' })
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/teams/web/members/carol', bob, { role: 'maintainer' })).status).toBe(204)
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/teams/web/repos/site', bob, { role: 'write' })).status).toBe(204)
    expect((await call(forge, BASE, 'PUT', '/api/orgs/guild/teams/web/repos/nope', bob, { role: 'write' })).status).toBe(404)
    const team = await json<{ members: { login: string; role: string }[]; repositories: { name: string; role: string }[] }>(await call(forge, BASE, 'GET', '/api/orgs/guild/teams/web', carol))
    expect(team.members).toEqual([expect.objectContaining({ login: 'carol', role: 'maintainer' })])
    expect(team.repositories).toEqual([expect.objectContaining({ name: 'site', role: 'write' })])
    const refs = await forge.fetch(new Request(`${BASE}/guild/site.git/info/refs?service=git-receive-pack`, { headers: { Authorization: `Basic ${btoa(`git:${carol}`)}` } }))
    expect(refs.status).toBe(200)
    expect((await call(forge, BASE, 'DELETE', '/api/orgs/guild/teams/web/repos/site', bob)).status).toBe(204)
    expect((await call(forge, BASE, 'DELETE', '/api/orgs/guild/teams/web/members/carol', bob)).status).toBe(204)
    expect((await json<{ members: unknown[] }>(await call(forge, BASE, 'GET', '/api/orgs/guild/teams/web', bob))).members).toEqual([])
    expect((await call(forge, BASE, 'GET', '/api/orgs/guild/teams/web', undefined)).status).toBe(404)
  })
})

describe('instance admin API', () => {
  it('lists and changes admins and trusted instances', async () => {
    expect((await call(forge, BASE, 'GET', '/api/admin/admins', bob)).status).toBe(403)
    expect(await json(await call(forge, BASE, 'GET', '/api/admin/admins', ada))).toEqual([expect.objectContaining({ login: 'ada' })])
    expect((await call(forge, BASE, 'DELETE', '/api/admin/admins/ada', ada)).status).toBe(422)
    expect((await call(forge, BASE, 'PUT', '/api/admin/admins/bob', ada)).status).toBe(204)
    expect((await call(forge, BASE, 'POST', '/api/admin/instances', bob, { issuer: 'https://mirror.example/' })).status).toBe(200)
    expect((await call(forge, BASE, 'POST', '/api/admin/instances', bob, { issuer: 'not a url' })).status).toBe(422)
    expect(await json(await call(forge, BASE, 'GET', '/api/admin/instances', bob))).toEqual([expect.objectContaining({ issuer: 'https://mirror.example', pinnedThumbprint: null })])
    expect((await call(forge, BASE, 'DELETE', `/api/admin/instances/${encodeURIComponent('https://mirror.example')}`, bob)).status).toBe(204)
    expect(await json(await call(forge, BASE, 'GET', '/api/admin/instances', bob))).toEqual([])
    expect((await call(forge, BASE, 'DELETE', '/api/admin/admins/bob', ada)).status).toBe(204)
    expect((await call(forge, BASE, 'GET', '/api/admin/instances', bob)).status).toBe(403)
  })

  it('refuses reserved names for new users and lists the mirrors of the instance', async () => {
    expect((await call(forge, BASE, 'POST', '/api/admin/users', ada, { login: 'settings' })).status).toBe(422)
    expect((await call(forge, BASE, 'POST', '/api/repos', ada, { owner: 'ada', name: 'copy' })).status).toBe(201)
    expect((await call(forge, BASE, 'POST', '/api/repos/ada/copy/mirrors', ada, { url: 'http://127.0.0.1:9/upstream.git', mode: 'manual' })).status).toBe(201)
    const mirrors = await json<{ repository: { owner: string; name: string }; config: { url: string } }[]>(await call(forge, BASE, 'GET', '/api/admin/mirrors', ada))
    expect(mirrors).toEqual([expect.objectContaining({ repository: { owner: 'ada', name: 'copy' }, config: expect.objectContaining({ url: 'http://127.0.0.1:9/upstream.git' }) })])
    expect((await call(forge, BASE, 'GET', '/api/admin/mirrors', bob)).status).toBe(403)
  })

  it('sends a test email through the configured provider', async () => {
    expect((await call(forge, BASE, 'POST', '/api/admin/email/test', ada, { to: 'ada@example.org' })).status).toBe(422)
    const email = createMemoryEmailSender('forge@example.org')
    const mailing = await nodeForge({ email })
    const admin = await bootstrap(mailing, BASE, 'ada')
    expect((await call(mailing, BASE, 'POST', '/api/admin/email/test', admin, {})).status).toBe(422)
    expect((await call(mailing, BASE, 'POST', '/api/admin/email/test', admin, { to: 'not-an-address' })).status).toBe(422)
    expect(await json(await call(mailing, BASE, 'POST', '/api/admin/email/test', admin, { to: 'ada@example.org' }))).toEqual({ id: 'memory-1' })
    expect(email.sent).toEqual([expect.objectContaining({ to: ['ada@example.org'], subject: 'git-forge test email' })])
    const invite = await json<{ url: string; emailed: boolean }>(await call(mailing, BASE, 'POST', '/api/admin/invites', admin, { login: 'dora', email: 'dora@example.org' }))
    expect(invite.emailed).toBe(true)
    expect(email.sent[1]).toMatchObject({ to: ['dora@example.org'], text: expect.stringContaining(invite.url) })
    expect(await json(await call(forge, BASE, 'POST', '/api/admin/invites', ada, { login: 'erin', email: 'erin@example.org' }))).toMatchObject({ emailed: false })
    expect((await call(forge, BASE, 'POST', '/api/admin/email/test', carol, { to: 'carol@example.org' })).status).toBe(403)
  })
})
