import { beforeEach, describe, expect, it } from 'vitest'
import {
  type AccountsStore,
  applyMigrations,
  type AuthorizeRequest,
  checkRepositoryAccess,
  createAccountsStore,
  createFederationInstallationStore,
  type FederationInstallationStore,
  generateSigningKey,
  type InstancePrincipal,
  MIGRATIONS,
  mintInstallationToken,
  parseAuthorizeRequest,
  type SigningKey,
  verifyInstallationToken,
} from '@git-forge/accounts'
import { testDatabase } from './database.ts'

const B = 'https://beta.example'
const A = 'https://alpha.example'

const request: AuthorizeRequest = {
  issuer: B,
  redirectUri: `${B}/federation/callback`,
  state: 's'.repeat(32),
  challenge: 'c'.repeat(43),
  subject: 'mira',
  login: 'mira',
  scopes: ['git:read', 'lfs:read'],
}

let store: AccountsStore
let installations: FederationInstallationStore
let anna: string
let org: string
let vault: string

const principal = (installation: string, overrides: Partial<InstancePrincipal> = {}): InstancePrincipal => ({
  kind: 'instance',
  issuer: B,
  repositories: ['anna/vault', 'anna/diary', 'acme/plans'],
  scopes: ['git:read', 'lfs:read'],
  tokenId: 't',
  installation: { id: installation, subject: 'mira' },
  ...overrides,
})

const reads = async (who: InstancePrincipal, owner: string, name: string, surface: 'git' | 'lfs' = 'git') =>
  (await checkRepositoryAccess(store, who, { owner, name }, 'read', surface)).decision

beforeEach(async () => {
  const db = await testDatabase()
  await applyMigrations(db, MIGRATIONS)
  store = createAccountsStore(db)
  installations = createFederationInstallationStore(db)
  anna = (await store.createUser({ login: 'anna' })).id
  org = (await store.createOrganization({ login: 'acme' })).id
  await store.setOrganizationMember(org, anna, 'owner')
  vault = (await store.createRepository({ ownerId: anna, name: 'vault', visibility: 'private' })).id
  await store.createRepository({ ownerId: anna, name: 'diary', visibility: 'private' })
  await store.createRepository({ ownerId: org, name: 'plans', visibility: 'private' })
})

describe('federation installation authorization', () => {
  it('reads selected repositories only, for the issuer and subject it was granted to', async () => {
    const { installation } = await installations.install({ request, accountId: anna, selection: 'selected', repositoryIds: [vault], grantedBy: anna })
    expect(await reads(principal(installation), 'anna', 'vault')).toBe('allow')
    expect(await reads(principal(installation), 'anna', 'vault', 'lfs')).toBe('allow')
    expect(await reads(principal(installation), 'anna', 'diary')).toBe('not-found')
    expect(await reads(principal(installation), 'acme', 'plans')).toBe('not-found')
    expect(await reads(principal(installation, { installation: { id: installation, subject: 'eve' } }), 'anna', 'vault')).toBe('not-found')
    expect(await reads(principal(installation, { issuer: 'https://mallory.example' }), 'anna', 'vault')).toBe('not-found')
    expect(await reads(principal(installation, { repositories: ['anna/diary'] }), 'anna', 'vault')).toBe('not-found')
    expect(await reads(principal(installation, { scopes: ['git:read'] }), 'anna', 'vault', 'lfs')).toBe('not-found')
    const { installation: _, ...trustTable } = principal(installation)
    expect(await reads(trustTable, 'anna', 'vault')).toBe('not-found')
  })

  it('stops reading once revoked', async () => {
    const { installation } = await installations.install({ request, accountId: anna, selection: 'all', repositoryIds: [], grantedBy: anna })
    expect(await reads(principal(installation), 'anna', 'diary')).toBe('allow')
    expect(await installations.revoke(installation, { kind: 'user', id: anna })).toBe(true)
    expect(await reads(principal(installation), 'anna', 'diary')).toBe('not-found')
    expect(await installations.revoke(installation, { kind: 'user', id: anna })).toBe(false)
  })

  it('stops reading when the granting user loses access', async () => {
    const { installation } = await installations.install({ request, accountId: org, selection: 'all', repositoryIds: [], grantedBy: anna })
    expect(await reads(principal(installation), 'acme', 'plans')).toBe('allow')
    await store.removeOrganizationMember(org, anna)
    expect(await reads(principal(installation), 'acme', 'plans')).toBe('not-found')
    await store.setOrganizationMember(org, anna, 'owner')
    expect(await reads(principal(installation), 'acme', 'plans')).toBe('allow')
    await store.disableAccount(anna)
    expect(await reads(principal(installation), 'acme', 'plans')).toBe('not-found')
  })

  it('redeems a code once, only with the matching verifier and redirect URI', async () => {
    const verifier = 'v'.repeat(43)
    const { pkceChallenge } = await import('@git-forge/accounts')
    const { installation, code } = await installations.install({ request: { ...request, challenge: await pkceChallenge(verifier) }, accountId: anna, selection: 'all', repositoryIds: [], grantedBy: anna })
    expect((await installations.codeInstallation(code))?.id).toBe(installation)
    expect(await installations.redeemCode(code, `${B}/other`, verifier)).toBe(false)
    expect(await installations.redeemCode(code, request.redirectUri, 'w'.repeat(43))).toBe(false)
    expect(await installations.redeemCode(code, request.redirectUri, verifier)).toBe(true)
    expect(await installations.redeemCode(code, request.redirectUri, verifier)).toBe(false)
    expect(await installations.codeInstallation(code)).toBeNull()
  })
})

describe('installation tokens', () => {
  let key: SigningKey
  const jwks = { keys: async () => [key.publicJwk] }

  beforeEach(async () => {
    key = (await generateSigningKey()).key
  })

  it('verify only for an active installation with matching issuer and subject', async () => {
    const { installation } = await installations.install({ request: { ...request, scopes: ['git:read'] }, accountId: anna, selection: 'all', repositoryIds: [], grantedBy: anna })
    const mint = (subject: string, issuer = B) => mintInstallationToken({ key, issuer, audience: A, subject, installation, repositories: ['anna/vault'] })
    const options = { audience: A, jwks, installation: installations.installation }
    const ok = await verifyInstallationToken(await mint('mira'), options)
    expect(ok).toEqual({ ok: true, principal: expect.objectContaining({ issuer: B, scopes: ['git:read'], repositories: ['anna/vault'], installation: { id: installation, subject: 'mira' } }) })
    expect(await verifyInstallationToken(await mint('eve'), options)).toEqual({ ok: false, reason: 'invalid-subject' })
    expect(await verifyInstallationToken(await mint('mira', 'https://mallory.example'), options)).toEqual(expect.objectContaining({ ok: false, reason: 'unknown-issuer' }))
    await installations.revoke(installation, { kind: 'user', id: anna })
    expect(await verifyInstallationToken(await mint('mira'), options)).toEqual({ ok: false, reason: 'revoked' })
  })

  it('parses authorize requests with redirect URIs below the client only', () => {
    const params = (overrides: Record<string, string>) =>
      new URLSearchParams({ client_id: B, redirect_uri: `${B}/federation/callback`, state: request.state, code_challenge: request.challenge, code_challenge_method: 'S256', sub: 'mira', ...overrides })
    expect(parseAuthorizeRequest(params({})).scopes).toEqual(['git:read', 'lfs:read'])
    for (const bad of [{ redirect_uri: `${A}/federation/callback` }, { redirect_uri: `${B}.evil/federation/callback` }, { code_challenge_method: 'plain' }, { scope: 'git:write' }, { sub: 'instance' }, { state: 'a b' }]) {
      expect(() => parseAuthorizeRequest(params(bad))).toThrow()
    }
  })
})
