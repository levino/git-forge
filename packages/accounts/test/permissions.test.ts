import { describe, expect, it } from 'vitest'
import {
  type Access,
  ANONYMOUS,
  decide,
  type Grants,
  NO_GRANTS,
  type Principal,
  type RepositorySubject,
  resolveAccess,
  type Role,
} from '../src/index.ts'

const alice: Principal = { kind: 'user', id: 'alice', login: 'alice', limits: null, tokenId: null }
const bob: Principal = { kind: 'user', id: 'bob', login: 'bob', limits: null, tokenId: null }

const userRepo = (visibility: 'public' | 'private'): RepositorySubject => ({
  id: `user-${visibility}`,
  owner: 'alice',
  name: 'notes',
  ownerId: 'alice',
  ownerKind: 'user',
  visibility,
  defaultRole: null,
})

const orgRepo = (visibility: 'public' | 'private', defaultRole: Role | null = null): RepositorySubject => ({
  id: `org-${visibility}`,
  owner: 'village',
  name: 'archive',
  ownerId: 'village',
  ownerKind: 'organization',
  visibility,
  defaultRole,
})

const grants = (overrides: Partial<Grants>): Grants => ({ ...NO_GRANTS, ...overrides })

type Case = readonly [string, Principal, RepositorySubject, Grants, Access]

const cases: readonly Case[] = [
  ['anonymous reads public user repo', ANONYMOUS, userRepo('public'), NO_GRANTS, 'read'],
  ['anonymous sees nothing of private user repo', ANONYMOUS, userRepo('private'), NO_GRANTS, 'none'],
  ['anonymous ignores grants', ANONYMOUS, userRepo('private'), grants({ collaboratorRole: 'admin' }), 'none'],
  ['owner is admin of own private repo', alice, userRepo('private'), NO_GRANTS, 'admin'],
  ['owner is admin of own public repo', alice, userRepo('public'), NO_GRANTS, 'admin'],
  ['stranger reads public user repo', bob, userRepo('public'), NO_GRANTS, 'read'],
  ['stranger sees nothing of private user repo', bob, userRepo('private'), NO_GRANTS, 'none'],
  ['collaborator gets triage', bob, userRepo('private'), grants({ collaboratorRole: 'triage' }), 'triage'],
  ['collaborator gets write', bob, userRepo('private'), grants({ collaboratorRole: 'write' }), 'write'],
  ['team roles are ignored for user-owned repos', bob, userRepo('private'), grants({ teamRoles: ['admin'] }), 'none'],
  ['org owner is admin', bob, orgRepo('private'), grants({ organizationRole: 'owner' }), 'admin'],
  ['org member without base role sees nothing', bob, orgRepo('private'), grants({ organizationRole: 'member' }), 'none'],
  ['org member gets base role', bob, orgRepo('private', 'read'), grants({ organizationRole: 'member' }), 'read'],
  ['base role does not apply to non-members', bob, orgRepo('private', 'write'), NO_GRANTS, 'none'],
  ['team role applies to members', bob, orgRepo('private'), grants({ organizationRole: 'member', teamRoles: ['maintain'] }), 'maintain'],
  ['highest team role wins', bob, orgRepo('private'), grants({ organizationRole: 'member', teamRoles: ['read', 'write', 'triage'] }), 'write'],
  ['team role needs org membership', bob, orgRepo('private'), grants({ teamRoles: ['write'] }), 'none'],
  ['outside collaborator on org repo', bob, orgRepo('private'), grants({ collaboratorRole: 'write' }), 'write'],
  ['max of base, team and collaborator', bob, orgRepo('private', 'triage'), grants({ organizationRole: 'member', teamRoles: ['read'], collaboratorRole: 'maintain' }), 'maintain'],
  ['public org repo is readable by members without roles', bob, orgRepo('public'), grants({ organizationRole: 'member' }), 'read'],
  ['user principal ignores app and instance grants', bob, orgRepo('private'), grants({ appRole: 'admin', instanceRole: 'read' }), 'none'],
]

const tokenCases: readonly Case[] = [
  ['read-scoped token caps owner at read', { ...alice, limits: { ceiling: 'read', repositoryIds: null } } as Principal, userRepo('private'), NO_GRANTS, 'read'],
  ['write-scoped token caps admin at write', { ...alice, limits: { ceiling: 'write', repositoryIds: null } } as Principal, userRepo('private'), NO_GRANTS, 'write'],
  ['scopeless token only sees public', { ...alice, limits: { ceiling: 'none', repositoryIds: null } } as Principal, userRepo('private'), NO_GRANTS, 'none'],
  ['scopeless token still reads public repos', { ...alice, limits: { ceiling: 'none', repositoryIds: null } } as Principal, userRepo('public'), NO_GRANTS, 'read'],
  ['repository-restricted token outside its list', { ...alice, limits: { ceiling: 'admin', repositoryIds: ['other'] } } as Principal, userRepo('private'), NO_GRANTS, 'none'],
  ['repository-restricted token inside its list', { ...alice, limits: { ceiling: 'admin', repositoryIds: ['user-private'] } } as Principal, userRepo('private'), NO_GRANTS, 'admin'],
  ['token never raises access above grants', { ...bob, limits: { ceiling: 'admin', repositoryIds: null } } as Principal, userRepo('private'), grants({ collaboratorRole: 'read' }), 'read'],
]

const app = (ceiling: Access, repositoryIds: readonly string[] | null = null): Principal => ({
  kind: 'app',
  id: 'mirror',
  slug: 'mirror',
  limits: { ceiling, repositoryIds },
  tokenId: 't',
})

const appCases: readonly Case[] = [
  ['app without grant sees nothing', app('admin'), orgRepo('private'), NO_GRANTS, 'none'],
  ['app with read grant', app('admin'), orgRepo('private'), grants({ appRole: 'read' }), 'read'],
  ['app token scope caps app grant', app('read'), orgRepo('private'), grants({ appRole: 'write' }), 'read'],
  ['app ignores user-style grants', app('admin'), orgRepo('private'), grants({ organizationRole: 'owner', collaboratorRole: 'admin' }), 'none'],
  ['app reads public repos without grant', app('none'), orgRepo('public'), NO_GRANTS, 'read'],
]

const instance = (repositories: readonly string[]): Principal => ({
  kind: 'instance',
  issuer: 'https://b.example',
  repositories,
  scopes: ['git:read', 'lfs:read'],
  tokenId: 'jti',
})

const instanceCases: readonly Case[] = [
  ['instance with trust grant and claim reads', instance(['village/archive']), orgRepo('private'), grants({ instanceRole: 'read' }), 'read'],
  ['instance claim is case-insensitive', instance(['village/archive']), { ...orgRepo('private'), owner: 'Village', name: 'Archive' }, grants({ instanceRole: 'read' }), 'read'],
  ['instance without trust grant sees nothing', instance(['village/archive']), orgRepo('private'), NO_GRANTS, 'none'],
  ['instance token for another repo sees nothing', instance(['village/other']), orgRepo('private'), grants({ instanceRole: 'read' }), 'none'],
  ['instance never gets more than read', instance(['village/archive']), orgRepo('private'), grants({ instanceRole: 'read', collaboratorRole: 'admin', appRole: 'admin' }), 'read'],
]

describe('resolveAccess', () => {
  it.each([...cases, ...tokenCases, ...appCases, ...instanceCases])('%s', (_name, principal, repo, given, expected) => {
    expect(resolveAccess(principal, repo, given)).toBe(expected)
  })
})

describe('decide', () => {
  const table: readonly (readonly [Principal, Access, Role, string])[] = [
    [ANONYMOUS, 'read', 'read', 'allow'],
    [ANONYMOUS, 'none', 'read', 'unauthenticated'],
    [ANONYMOUS, 'read', 'write', 'unauthenticated'],
    [bob, 'none', 'read', 'not-found'],
    [bob, 'none', 'write', 'not-found'],
    [bob, 'read', 'write', 'forbidden'],
    [bob, 'triage', 'write', 'forbidden'],
    [bob, 'write', 'write', 'allow'],
    [bob, 'admin', 'write', 'allow'],
    [bob, 'maintain', 'admin', 'forbidden'],
  ]
  it.each(table)('%o with %s needing %s is %s', (principal, access, required, expected) => {
    expect(decide(principal, access, required)).toBe(expected)
  })
})
