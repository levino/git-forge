import type { OrganizationRole } from './permissions.ts'
import { type AccountsStore, isReservedLogin, LOGIN_PATTERN, TEAM_SLUG_PATTERN } from './store.ts'

export type MembershipSource = 'forge' | 'idp'

export const DEFAULT_GROUPS_CLAIM = 'groups'

export const isMembershipSource = (value: unknown): value is MembershipSource => value === 'forge' || value === 'idp'

export const groupValues = (claim: unknown): string[] => {
  if (typeof claim === 'string') return [claim]
  if (Array.isArray(claim)) return claim.filter((value): value is string => typeof value === 'string')
  return typeof claim === 'object' && claim !== null ? Object.keys(claim) : []
}

export type GroupMemberships = {
  readonly organizations: ReadonlyMap<string, { readonly login: string; readonly role: OrganizationRole }>
  readonly teams: readonly { readonly organization: string; readonly slug: string }[]
}

const GROUP = /^([^/:]+)(?:\/([^/:]+)|:(owner|member))?$/

export const parseGroups = (values: readonly string[]): GroupMemberships => {
  const organizations = new Map<string, { login: string; role: OrganizationRole }>()
  const teams = new Map<string, { organization: string; slug: string }>()
  for (const value of values) {
    const match = GROUP.exec(value.trim())
    if (!match || !LOGIN_PATTERN.test(match[1]!) || (match[2] !== undefined && !TEAM_SLUG_PATTERN.test(match[2]))) continue
    const key = match[1]!.toLowerCase()
    const role: OrganizationRole = match[3] === 'owner' || organizations.get(key)?.role === 'owner' ? 'owner' : 'member'
    organizations.set(key, { login: organizations.get(key)?.login ?? match[1]!, role })
    if (match[2] !== undefined) teams.set(`${key}/${match[2].toLowerCase()}`, { organization: key, slug: match[2] })
  }
  return { organizations, teams: [...teams.values()] }
}

export type MembershipStore = Pick<AccountsStore, 'findAccount' | 'createOrganization' | 'findTeam' | 'createTeam' | 'replaceMemberships'>

export const ensureOrganization = async (store: Pick<MembershipStore, 'findAccount' | 'createOrganization'>, login: string): Promise<string | null> => {
  const existing = await store.findAccount(login)
  if (existing) return existing.kind === 'organization' ? existing.id : null
  if (isReservedLogin(login)) return null
  try {
    return (await store.createOrganization({ login })).id
  } catch {
    const raced = await store.findAccount(login)
    return raced?.kind === 'organization' ? raced.id : null
  }
}

export const ensureTeam = async (store: Pick<MembershipStore, 'findTeam' | 'createTeam'>, organizationId: string, slug: string): Promise<string> => {
  const existing = await store.findTeam(organizationId, slug)
  if (existing) return existing.id
  try {
    return (await store.createTeam(organizationId, { slug, name: slug })).id
  } catch (error) {
    const raced = await store.findTeam(organizationId, slug)
    if (!raced) throw error
    return raced.id
  }
}

export const syncMemberships = async (store: MembershipStore, userId: string, values: readonly string[]): Promise<boolean> => {
  const groups = parseGroups(values)
  const organizations = new Map<string, { id: string; role: OrganizationRole }>()
  for (const [key, entry] of groups.organizations) {
    const id = await ensureOrganization(store, entry.login)
    if (id) organizations.set(key, { id, role: entry.role })
  }
  const teams: string[] = []
  for (const team of groups.teams) {
    const organization = organizations.get(team.organization)
    if (organization) teams.push(await ensureTeam(store, organization.id, team.slug))
  }
  return store.replaceMemberships(userId, [...organizations.values()], teams)
}
