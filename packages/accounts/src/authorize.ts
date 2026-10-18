import type { Authorize, ReadView, RepositoryName, Surface } from '@git-forge/core'
import { fromUtf8, base64UrlDecode } from './encoding.ts'
import { looksLikeJwt } from './jwt.ts'
import {
  ANONYMOUS,
  archivedBlocks,
  type Decision,
  decide,
  type Grants,
  type InstancePrincipal,
  NO_GRANTS,
  type Principal,
  type RepositorySubject,
  resolveAccess,
} from './permissions.ts'
import { type Access, atLeast, type Role } from './roles.ts'
import { compileView, type VisibilityRule } from './visibility.ts'

export const REALM = 'git-forge'

export type Credential = { readonly kind: 'none' } | { readonly kind: 'secret'; readonly secret: string } | { readonly kind: 'malformed' }

const decodeBase64 = (text: string): string | null => {
  try {
    return fromUtf8(base64UrlDecode(text.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')))
  } catch {
    return null
  }
}

export const parseAuthorization = (header: string | null): Credential => {
  if (header === null || header.trim() === '') return { kind: 'none' }
  const match = /^\s*(\S+)\s+(\S+)\s*$/.exec(header)
  if (!match) return { kind: 'malformed' }
  const scheme = match[1]!.toLowerCase()
  const value = match[2]!
  if (scheme === 'bearer' || scheme === 'token') return { kind: 'secret', secret: value }
  if (scheme !== 'basic') return { kind: 'malformed' }
  const decoded = decodeBase64(value)
  if (decoded === null) return { kind: 'malformed' }
  const colon = decoded.indexOf(':')
  if (colon < 0) return { kind: 'malformed' }
  const password = decoded.slice(colon + 1)
  return password === '' ? { kind: 'none' } : { kind: 'secret', secret: password }
}

export type RepositoryDirectory = {
  readonly authenticateToken: (token: string) => Promise<Principal | null>
  readonly findRepository: (owner: string, name: string) => Promise<RepositorySubject | null>
  readonly grantsFor: (principal: Principal, repo: RepositorySubject) => Promise<Grants>
  readonly visibilityRules?: (principal: Principal, repo: RepositorySubject, surface: Surface) => Promise<readonly VisibilityRule[]>
}

export type InstanceVerifier = (token: string) => Promise<InstancePrincipal | null>

export type AuthenticateOptions = {
  readonly directory: RepositoryDirectory
  readonly verifyInstance?: InstanceVerifier
}

export const authenticateRequest = async (request: Request, options: AuthenticateOptions): Promise<Principal | null> => {
  const credential = parseAuthorization(request.headers.get('Authorization'))
  if (credential.kind === 'none') return ANONYMOUS
  if (credential.kind === 'malformed') return null
  if (looksLikeJwt(credential.secret)) return options.verifyInstance ? options.verifyInstance(credential.secret) : null
  return options.directory.authenticateToken(credential.secret)
}

export type AccessCheck = {
  readonly decision: Decision
  readonly access: Access
  readonly repository: RepositorySubject | null
  readonly view?: ReadView | null
}

export const checkRepositoryAccess = async (
  directory: RepositoryDirectory,
  principal: Principal,
  repo: RepositoryName,
  required: Role,
  surface: Surface = 'git',
): Promise<AccessCheck> => {
  const repository = await directory.findRepository(repo.owner, repo.name)
  if (!repository) return { decision: decide(principal, 'none', required), access: 'none', repository: null }
  const usable = principal.kind !== 'instance' || principal.scopes.includes(`${surface}:read`)
  const grants = usable ? await directory.grantsFor(principal, repository) : NO_GRANTS
  const access = resolveAccess(principal, repository, grants)
  const decision = archivedBlocks(repository, required) && atLeast(access, required) ? 'forbidden' : decide(principal, access, required)
  const partial = decision !== 'allow' && required === 'read' && directory.visibilityRules
  return { decision, access, repository, view: partial ? compileView(await directory.visibilityRules!(principal, repository, surface)) : null }
}

export const grantedView = (check: AccessCheck, principal: Principal): Response | ReadView | null =>
  check.view ?? decisionResponse(check.decision, principal, check.repository)

const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

export const challenge = (message = 'authentication required\n') => plain(401, message, { 'WWW-Authenticate': `Basic realm="${REALM}"` })

export const decisionResponse = (decision: Decision, principal: Principal, repository: RepositorySubject | null = null): Response | null => {
  switch (decision) {
    case 'allow':
      return null
    case 'unauthenticated':
      return challenge()
    case 'forbidden':
      if (repository?.archived) return plain(403, 'this repository is archived and read-only\n')
      return plain(403, principal.kind === 'user' ? `permission denied to ${principal.login}\n` : 'permission denied\n')
    case 'not-found':
      return plain(404, 'repository not found\n')
  }
}

export const createGitAuthorizer = (options: AuthenticateOptions): Authorize => async (request, repo, access, surface) => {
  const principal = await authenticateRequest(request, options)
  if (!principal) return challenge('invalid credentials\n')
  const check = await checkRepositoryAccess(options.directory, principal, repo, access === 'write' ? 'write' : 'read', surface)
  return grantedView(check, principal)
}
