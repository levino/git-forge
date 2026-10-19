import { parseAuthorization } from './authorize.ts'
import { type Database, first, sql, type SqlValue } from './database.ts'
import { chooseLogin, loginCandidates } from './login.ts'
import { ensureOrganization, ensureTeam } from './memberships.ts'
import { type AccountsStore, LOGIN_PATTERN, TEAM_SLUG_PATTERN } from './store.ts'

export const SCIM_PATH = '/scim/v2'

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User'
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group'
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse'
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error'
const MAX_COUNT = 200

export class ScimError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly scimType?: string,
  ) {
    super(message)
  }
}

export type ScimStore = Pick<
  AccountsStore,
  | 'findAccount'
  | 'createUser'
  | 'findUserById'
  | 'setUserActive'
  | 'createOrganization'
  | 'findTeam'
  | 'createTeam'
  | 'organizationRole'
  | 'setOrganizationMember'
  | 'removeOrganizationMember'
  | 'listTeamMembers'
  | 'setTeamMember'
  | 'removeTeamMember'
  | 'teamsOf'
>

export type ScimOptions = {
  readonly db: Database
  readonly store: ScimStore
  readonly origin: string
  readonly enabled: boolean
  readonly authenticate: (token: string) => Promise<boolean>
  readonly now: () => number
}

type UserRow = {
  id: string
  login: string
  display_name: string | null
  email: string | null
  disabled_at: number | null
  user_name: string
  external_id: string | null
  created_at: number
  updated_at: number
}

type TeamRow = { id: string; organization_id: string; organization: string; slug: string; created_at: number }

type UserInput = { userName?: string; externalId?: string | null; displayName?: string | null; name?: string | null; email?: string | null; active?: boolean }

const USER_SELECT =
  'SELECT a.id, a.login, a.display_name, a.email, a.disabled_at, s.user_name, s.external_id, s.created_at, s.updated_at FROM scim_users s JOIN accounts a ON a.id = s.account_id'

const TEAM_SELECT = 'SELECT t.id, t.organization_id, o.login AS organization, t.slug, t.created_at FROM teams t JOIN accounts o ON o.id = t.organization_id'

const FILTER = /^\s*([A-Za-z.]+)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i

export const parseScimFilter = (text: string | null): { readonly attribute: string; readonly value: string } | null => {
  if (text === null || text.trim() === '') return null
  const match = FILTER.exec(text)
  if (!match) throw new ScimError(400, 'only filters of the form attribute eq "value" are supported', 'invalidFilter')
  return { attribute: match[1]!.toLowerCase(), value: match[2]!.replace(/\\(.)/g, '$1') }
}

const text = (value: unknown, name: string): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new ScimError(400, `${name} must be a string`, 'invalidValue')
  return value.trim() || null
}

const bool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true'
  throw new ScimError(400, 'active must be a boolean', 'invalidValue')
}

const object = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

const primaryEmail = (value: unknown): string | null => {
  const emails = (Array.isArray(value) ? value : []).map(object).filter((entry) => typeof entry.value === 'string')
  return text((emails.find((entry) => entry.primary === true || entry.primary === 'true') ?? emails[0])?.value, 'emails')
}

export const applyUserAttribute = (input: UserInput, path: string, value: unknown): void => {
  const key = path.toLowerCase()
  if (key === 'username') {
    const userName = text(value, 'userName')
    if (userName) input.userName = userName
  } else if (key === 'externalid') input.externalId = text(value, 'externalId')
  else if (key === 'displayname') input.displayName = text(value, 'displayName')
  else if (key === 'name') {
    const name = object(value)
    input.name = text(name.formatted, 'name.formatted') ?? (text([name.givenName, name.familyName].filter((part) => typeof part === 'string').join(' '), 'name') || null)
  } else if (key === 'name.formatted') input.name = text(value, 'name.formatted')
  else if (key === 'emails') input.email = primaryEmail(value)
  else if (/^emails\[.*\]\.value$/.test(key)) input.email = text(value, 'emails')
  else if (key === 'active') input.active = bool(value)
}

const userInput = (body: Record<string, unknown>): UserInput => {
  const input: UserInput = {}
  for (const [key, value] of Object.entries(body)) applyUserAttribute(input, key, value)
  return input
}

const operations = (body: Record<string, unknown>) => {
  if (!Array.isArray(body.Operations)) throw new ScimError(400, 'a PatchOp needs Operations', 'invalidSyntax')
  return body.Operations.map(object).map((operation) => ({
    op: String(operation.op ?? '').toLowerCase(),
    path: typeof operation.path === 'string' ? operation.path : null,
    value: operation.value,
  }))
}

const memberIds = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).map(object).flatMap((member) => (typeof member.value === 'string' ? [member.value] : []))

const MEMBER_PATH = /^members\[\s*value\s+eq\s+"([^"]+)"\s*\]$/i

export const createScimHandler = (options: ScimOptions) => {
  const { db, store } = options
  const iso = (ms: number) => new Date(ms).toISOString()
  const location = (kind: 'Users' | 'Groups', id: string) => `${options.origin}${SCIM_PATH}/${kind}/${id}`

  const userJson = (row: UserRow) => ({
    schemas: [USER],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    displayName: row.display_name ?? row.login,
    name: { formatted: row.display_name ?? row.login },
    ...(row.email ? { emails: [{ value: row.email, primary: true, type: 'work' }] } : {}),
    active: row.disabled_at === null,
    meta: { resourceType: 'User', created: iso(row.created_at), lastModified: iso(row.updated_at), location: location('Users', row.id) },
  })

  const groupJson = async (row: TeamRow, withMembers = true) => ({
    schemas: [GROUP],
    id: row.id,
    displayName: `${row.organization}/${row.slug}`,
    ...(withMembers ? { members: (await store.listTeamMembers(row.id)).map((member) => ({ value: member.id, display: member.login, $ref: location('Users', member.id) })) } : {}),
    meta: { resourceType: 'Group', created: iso(row.created_at), lastModified: iso(row.created_at), location: location('Groups', row.id) },
  })

  const user = async (id: string): Promise<UserRow> => {
    const row = await first<UserRow>(db, sql(`${USER_SELECT} WHERE s.account_id = ?`, id))
    if (!row) throw new ScimError(404, `user ${id} not found`)
    return row
  }

  const team = async (id: string): Promise<TeamRow> => {
    const row = await first<TeamRow>(db, sql(`${TEAM_SELECT} WHERE t.id = ?`, id))
    if (!row) throw new ScimError(404, `group ${id} not found`)
    return row
  }

  const page = (url: URL) => {
    const start = Math.max(1, Number.parseInt(url.searchParams.get('startIndex') ?? '1', 10) || 1)
    const count = Math.min(MAX_COUNT, Math.max(0, Number.parseInt(url.searchParams.get('count') ?? String(MAX_COUNT), 10) || 0))
    return { start, count }
  }

  const list = async <T>(url: URL, from: string, where: string, params: readonly SqlValue[], order: string, render: (row: T) => unknown) => {
    const { start, count } = page(url)
    const total = (await first<{ n: number }>(db, sql(`SELECT COUNT(*) AS n FROM (${from} ${where})`, ...params)))?.n ?? 0
    const rows = count === 0 ? [] : await db.all<T & Record<string, SqlValue>>(sql(`${from} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, count, start - 1))
    return { schemas: [LIST], totalResults: total, startIndex: start, itemsPerPage: rows.length, Resources: await Promise.all(rows.map(render)) }
  }

  const userFilter = (filter: ReturnType<typeof parseScimFilter>): [string, SqlValue[]] => {
    if (!filter) return ['', []]
    const column = { username: 's.user_name', externalid: 's.external_id', id: 's.account_id' }[filter.attribute]
    if (!column) throw new ScimError(400, `cannot filter users by ${filter.attribute}`, 'invalidFilter')
    return [`WHERE ${column} = ?`, [filter.value]]
  }

  const groupFilter = (filter: ReturnType<typeof parseScimFilter>): [string, SqlValue[]] => {
    if (!filter) return ['', []]
    if (filter.attribute === 'id') return ['WHERE t.id = ?', [filter.value]]
    if (filter.attribute !== 'displayname') throw new ScimError(400, `cannot filter groups by ${filter.attribute}`, 'invalidFilter')
    const [organization, slug, extra] = filter.value.split('/')
    return organization && slug && extra === undefined ? ['WHERE o.login = ? AND t.slug = ?', [organization, slug]] : ['WHERE 0', []]
  }

  const requireFreeUserName = async (userName: string, self: string | null) => {
    const taken = await first<{ account_id: string }>(db, sql('SELECT account_id FROM scim_users WHERE user_name = ?', userName))
    if (taken && taken.account_id !== self) throw new ScimError(409, `userName ${userName} is already provisioned`, 'uniqueness')
  }

  const saveUser = async (row: UserRow, input: UserInput): Promise<UserRow> => {
    if (input.userName) await requireFreeUserName(input.userName, row.id)
    const displayName = input.displayName !== undefined ? input.displayName : input.name
    await db.batch([
      sql(
        'UPDATE scim_users SET user_name = ?, external_id = ?, updated_at = ? WHERE account_id = ?',
        input.userName ?? row.user_name,
        input.externalId !== undefined ? input.externalId : row.external_id,
        options.now(),
        row.id,
      ),
      sql(
        'UPDATE accounts SET display_name = ?, email = ? WHERE id = ?',
        displayName !== undefined ? displayName : row.display_name,
        input.email !== undefined ? input.email : row.email,
        row.id,
      ),
    ])
    if (input.active !== undefined && input.active !== (row.disabled_at === null)) await store.setUserActive(row.id, input.active)
    return user(row.id)
  }

  const createUser = async (input: UserInput): Promise<UserRow> => {
    if (!input.userName) throw new ScimError(400, 'userName is required', 'invalidValue')
    await requireFreeUserName(input.userName, null)
    const adopted = await first<{ id: string }>(
      db,
      sql(
        `SELECT a.id FROM external_identities e JOIN accounts a ON a.id = e.account_id
         WHERE (e.subject = ? OR e.email = ?) AND NOT EXISTS (SELECT 1 FROM scim_users s WHERE s.account_id = a.id) LIMIT 1`,
        input.externalId ?? '',
        input.userName,
      ),
    )
    const displayName = input.displayName ?? input.name ?? null
    const id =
      adopted?.id ??
      (
        await store.createUser({
          login: await chooseLogin(loginCandidates({ preferredUsername: input.userName, email: input.email ?? null, name: displayName }), async (login) => (await store.findAccount(login)) !== null),
          ...(displayName ? { displayName } : {}),
          ...(input.email ? { email: input.email } : {}),
        })
      ).id
    const at = options.now()
    await db.run(sql('INSERT INTO scim_users (account_id, user_name, external_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', id, input.userName, input.externalId ?? null, at, at))
    const row = await user(id)
    return saveUser(row, { ...input, active: input.active ?? true })
  }

  const patchUser = async (row: UserRow, body: Record<string, unknown>): Promise<UserRow> => {
    const input: UserInput = {}
    for (const operation of operations(body)) {
      if (operation.op === 'remove') {
        if (operation.path) applyUserAttribute(input, operation.path, null)
      } else if (operation.op === 'add' || operation.op === 'replace') {
        if (operation.path) applyUserAttribute(input, operation.path, operation.value)
        else for (const [key, value] of Object.entries(object(operation.value))) applyUserAttribute(input, key, value)
      } else throw new ScimError(400, `unknown op ${operation.op}`, 'invalidSyntax')
    }
    return saveUser(row, input)
  }

  const addMember = async (row: TeamRow, userId: string, current: ReadonlySet<string>) => {
    if (current.has(userId) || !(await store.findUserById(userId))) return
    if (!(await store.organizationRole(row.organization_id, userId))) await store.setOrganizationMember(row.organization_id, userId, 'member')
    await store.setTeamMember(row.id, userId, 'member')
  }

  const removeMember = async (row: TeamRow, userId: string) => {
    await store.removeTeamMember(row.id, userId)
    const elsewhere = (await store.teamsOf(userId)).some((entry) => entry.organizationId === row.organization_id)
    if (!elsewhere && (await store.organizationRole(row.organization_id, userId)) === 'member') await store.removeOrganizationMember(row.organization_id, userId)
  }

  const setMembers = async (row: TeamRow, ids: readonly string[], mode: 'add' | 'remove' | 'replace') => {
    const current = new Set((await store.listTeamMembers(row.id)).map((member) => member.id))
    const wanted = new Set(ids)
    if (mode !== 'remove') for (const id of wanted) await addMember(row, id, current)
    for (const id of current) if (mode === 'remove' ? wanted.has(id) : mode === 'replace' && !wanted.has(id)) await removeMember(row, id)
  }

  const requireSameName = (row: TeamRow, displayName: unknown) => {
    if (displayName !== undefined && String(displayName).toLowerCase() !== `${row.organization}/${row.slug}`.toLowerCase()) {
      throw new ScimError(400, 'groups cannot be renamed; create a new org/team group instead', 'mutability')
    }
  }

  const createGroup = async (body: Record<string, unknown>): Promise<TeamRow> => {
    const [organization, slug, extra] = String(body.displayName ?? '').split('/')
    if (!organization || !slug || extra !== undefined || !LOGIN_PATTERN.test(organization) || !TEAM_SLUG_PATTERN.test(slug)) {
      throw new ScimError(400, 'displayName must be org/team', 'invalidValue')
    }
    const organizationId = await ensureOrganization(store, organization)
    if (!organizationId) throw new ScimError(409, `${organization} is not an organization`, 'uniqueness')
    if (await store.findTeam(organizationId, slug)) throw new ScimError(409, `group ${organization}/${slug} exists`, 'uniqueness')
    const row = await team(await ensureTeam(store, organizationId, slug))
    await setMembers(row, memberIds(body.members ?? []), 'add')
    return row
  }

  const patchGroup = async (row: TeamRow, body: Record<string, unknown>) => {
    for (const operation of operations(body)) {
      const path = operation.path?.trim() ?? null
      const single = path ? MEMBER_PATH.exec(path) : null
      if (single && operation.op === 'remove') await setMembers(row, [single[1]!], 'remove')
      else if (path?.toLowerCase() === 'members') {
        if (operation.op === 'add') await setMembers(row, memberIds(operation.value), 'add')
        else if (operation.op === 'remove') await setMembers(row, operation.value === undefined ? (await store.listTeamMembers(row.id)).map((member) => member.id) : memberIds(operation.value), 'remove')
        else if (operation.op === 'replace') await setMembers(row, memberIds(operation.value), 'replace')
        else throw new ScimError(400, `unknown op ${operation.op}`, 'invalidSyntax')
      } else if (path?.toLowerCase() === 'displayname') requireSameName(row, operation.value)
      else if (path === null && (operation.op === 'replace' || operation.op === 'add')) {
        const value = object(operation.value)
        requireSameName(row, value.displayName)
        if (value.members !== undefined) await setMembers(row, memberIds(value.members), operation.op === 'add' ? 'add' : 'replace')
      } else if (path?.toLowerCase() !== 'externalid') throw new ScimError(400, `unsupported patch path ${path ?? ''}`, 'invalidPath')
    }
  }

  const route = async (request: Request, url: URL, parts: readonly string[]): Promise<{ status: number; body?: unknown; location?: string }> => {
    const [resource, id, extra] = parts
    const body = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH' ? object(await request.json().catch(() => null)) : {}
    const method = request.method
    if (extra !== undefined) throw new ScimError(404, 'not found')
    if (resource === 'ServiceProviderConfig' && !id && method === 'GET') {
      return {
        status: 200,
        body: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
          patch: { supported: true },
          bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
          filter: { supported: true, maxResults: MAX_COUNT },
          changePassword: { supported: false },
          sort: { supported: false },
          etag: { supported: false },
          authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'A token with the scim scope issued by an instance admin' }],
        },
      }
    }
    if (resource === 'Users') {
      if (!id && method === 'GET') {
        const [where, params] = userFilter(parseScimFilter(url.searchParams.get('filter')))
        return { status: 200, body: await list<UserRow>(url, USER_SELECT, where, params, 's.created_at, s.account_id', userJson) }
      }
      if (!id && method === 'POST') {
        const row = await createUser(userInput(body))
        return { status: 201, body: userJson(row), location: location('Users', row.id) }
      }
      if (!id) throw new ScimError(405, 'method not allowed')
      const row = await user(id)
      if (method === 'GET') return { status: 200, body: userJson(row) }
      if (method === 'PUT') return { status: 200, body: userJson(await saveUser(row, userInput(body))) }
      if (method === 'PATCH') return { status: 200, body: userJson(await patchUser(row, body)) }
      if (method === 'DELETE') {
        if (row.disabled_at === null) await store.setUserActive(row.id, false)
        await db.run(sql('DELETE FROM scim_users WHERE account_id = ?', row.id))
        return { status: 204 }
      }
    }
    if (resource === 'Groups') {
      if (!id && method === 'GET') {
        const [where, params] = groupFilter(parseScimFilter(url.searchParams.get('filter')))
        const members = !/(^|,)\s*members\s*(,|$)/i.test(url.searchParams.get('excludedAttributes') ?? '')
        return { status: 200, body: await list<TeamRow>(url, TEAM_SELECT, where, params, 'o.login, t.slug', (row) => groupJson(row, members)) }
      }
      if (!id && method === 'POST') {
        const row = await createGroup(body)
        return { status: 201, body: await groupJson(row), location: location('Groups', row.id) }
      }
      if (!id) throw new ScimError(405, 'method not allowed')
      const row = await team(id)
      if (method === 'GET') return { status: 200, body: await groupJson(row) }
      if (method === 'PUT') {
        requireSameName(row, body.displayName)
        await setMembers(row, memberIds(body.members ?? []), 'replace')
        return { status: 200, body: await groupJson(row) }
      }
      if (method === 'PATCH') {
        await patchGroup(row, body)
        return { status: 204 }
      }
      if (method === 'DELETE') {
        await setMembers(row, [], 'replace')
        return { status: 204 }
      }
    }
    throw new ScimError(404, 'not found')
  }

  const respond = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/scim+json', 'Cache-Control': 'no-store', ...headers } })

  const failure = (status: number, detail: string, scimType?: string) => respond(status, { schemas: [ERROR], status: String(status), detail, ...(scimType ? { scimType } : {}) })

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    if (url.pathname !== SCIM_PATH && !url.pathname.startsWith(`${SCIM_PATH}/`)) return null
    if (!options.enabled) return failure(404, 'SCIM is only available when MEMBERSHIP_SOURCE is idp')
    const credential = parseAuthorization(request.headers.get('Authorization'))
    if (credential.kind !== 'secret' || !(await options.authenticate(credential.secret))) return failure(401, 'a bearer token with the scim scope is required')
    try {
      const parts = url.pathname.slice(SCIM_PATH.length).split('/').filter((part) => part !== '').map(decodeURIComponent)
      const result = await route(request, url, parts)
      return respond(result.status, result.body, result.location ? { Location: result.location } : {})
    } catch (error) {
      if (error instanceof ScimError) return failure(error.status, error.message, error.scimType)
      throw error
    }
  }
}
