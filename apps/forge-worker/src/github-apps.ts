import {
  type AccountsStore,
  AppError,
  type AppPermissions,
  type AppRow,
  type AppsStore,
  base64UrlEncode,
  checkRepositoryAccess,
  type InstallationRow,
  parsePermissions,
  type Principal,
  randomBytes,
  type UserPrincipal,
} from '@git-forge/accounts'
import {
  ApiError,
  apiUrl,
  deliveryJson,
  hookConfig,
  hookEvents,
  isWebhookEventName,
  type Notifications,
  parseHookInput,
  repositoryObject,
  validateWebhookUrl,
} from '@git-forge/notifications'

export type GitHubAppsOptions = {
  readonly apps: AppsStore
  readonly accounts: AccountsStore
  readonly notifications: Notifications
  readonly principal: (request: Request) => Promise<Principal | null>
  readonly baseUrl: (request: Request) => string
  readonly allowInsecureWebhooks: boolean
}

type Account = { readonly id: string; readonly login: string; readonly kind: 'user' | 'organization' }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } })

const fail = (status: number, message: string): never => {
  throw new AppError(status, message)
}

const iso = (value: number | null): string | null => (value === null ? null : new Date(value).toISOString())

const accountJson = (baseUrl: string, account: Account) => ({
  login: account.login,
  id: account.id,
  node_id: account.id,
  type: account.kind === 'organization' ? 'Organization' : 'User',
  url: apiUrl(baseUrl, `/${account.kind === 'organization' ? 'orgs' : 'users'}/${account.login}`),
  html_url: `${baseUrl}/${account.login}`,
})

export const appJson = (baseUrl: string, app: AppRow, installationsCount?: number) => ({
  id: app.id,
  slug: app.slug,
  node_id: app.id,
  client_id: app.client_id,
  owner: accountJson(baseUrl, { id: app.owner_id, login: app.owner_login, kind: app.owner_kind }),
  name: app.name,
  description: app.description ?? '',
  external_url: app.external_url ?? `${baseUrl}/apps/${app.slug}`,
  html_url: `${baseUrl}/apps/${app.slug}`,
  created_at: iso(app.created_at),
  updated_at: iso(app.updated_at ?? app.created_at),
  permissions: JSON.parse(app.permissions) as AppPermissions,
  events: JSON.parse(app.events) as string[],
  ...(installationsCount !== undefined ? { installations_count: installationsCount } : {}),
})

export const installationJson = (baseUrl: string, installation: InstallationRow) => ({
  id: installation.id,
  account: accountJson(baseUrl, { id: installation.account_id, login: installation.account_login, kind: installation.account_kind }),
  repository_selection: installation.repository_selection,
  access_tokens_url: apiUrl(baseUrl, `/app/installations/${installation.id}/access_tokens`),
  repositories_url: apiUrl(baseUrl, '/installation/repositories'),
  html_url: `${baseUrl}/settings/installations/${installation.id}`,
  app_id: installation.app_id,
  app_slug: installation.app_slug,
  target_id: installation.account_id,
  target_type: installation.account_kind === 'organization' ? 'Organization' : 'User',
  permissions: JSON.parse(installation.permissions) as AppPermissions,
  events: JSON.parse(installation.events) as string[],
  created_at: iso(installation.created_at),
  updated_at: iso(installation.updated_at),
  single_file_name: null,
  suspended_at: iso(installation.suspended_at),
  suspended_by: null,
})

const randomSecret = (): string => base64UrlEncode(randomBytes(24))

export type ManifestInput = {
  readonly name?: unknown
  readonly url?: unknown
  readonly description?: unknown
  readonly hook_attributes?: { readonly url?: unknown; readonly active?: unknown }
  readonly redirect_url?: unknown
  readonly setup_url?: unknown
  readonly public?: unknown
  readonly default_permissions?: unknown
  readonly default_events?: unknown
}

export const parseManifest = (text: string): ManifestInput => {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as ManifestInput
  } catch {}
  return fail(422, 'the manifest must be a JSON object')
}

export const createGitHubApps = (options: GitHubAppsOptions) => {
  const { apps, accounts, notifications } = options

  const repoRows = async (ids: readonly string[]) => (await Promise.all(ids.map((id) => notifications.store.repositoryById(id)))).filter((row) => row !== null)

  const repoBrief = (rows: Awaited<ReturnType<typeof repoRows>>) =>
    rows.map((row) => ({ id: row.id, node_id: row.id, name: row.name, full_name: `${row.owner_login}/${row.name}`, private: row.visibility === 'private' }))

  const sender = (user: UserPrincipal) => ({ id: user.id, login: user.login })

  const sendInstallation = async (baseUrl: string, installation: InstallationRow, action: string, user: UserPrincipal, repositoryIds?: readonly string[]) => {
    const ids = repositoryIds ?? (await apps.installationRepositoryIds(installation))
    await notifications.emitToApp(
      installation.app_id,
      'installation',
      action,
      { installation: installationJson(baseUrl, installation), repositories: repoBrief(await repoRows(ids)), requester: null },
      sender(user),
      baseUrl,
    )
  }

  const sendRepositories = async (baseUrl: string, installation: InstallationRow, added: readonly string[], removed: readonly string[], user: UserPrincipal) => {
    if (added.length === 0 && removed.length === 0) return
    for (const [action, ids] of [
      ['added', added],
      ['removed', removed],
    ] as const) {
      if (ids.length === 0) continue
      await notifications.emitToApp(
        installation.app_id,
        'installation_repositories',
        action,
        {
          installation: installationJson(baseUrl, installation),
          repository_selection: installation.repository_selection,
          repositories_added: action === 'added' ? repoBrief(await repoRows(ids)) : [],
          repositories_removed: action === 'removed' ? repoBrief(await repoRows(ids)) : [],
          requester: null,
        },
        sender(user),
        baseUrl,
      )
    }
  }

  const managedAccounts = async (user: UserPrincipal): Promise<Account[]> => {
    const self = (await accounts.findUserById(user.id))!
    const organizations = await Promise.all((await accounts.ownedOrganizations(user.id)).map((login) => accounts.findAccount(login)))
    return [{ id: self.id, login: self.login, kind: 'user' }, ...organizations.flatMap((account) => (account ? [{ id: account.id, login: account.login, kind: account.kind }] : []))]
  }

  const canManageAccount = async (user: UserPrincipal, accountId: string): Promise<boolean> =>
    (await accounts.isInstanceAdmin(user.id)) || (await managedAccounts(user)).some((account) => account.id === accountId)

  const managedApp = async (user: UserPrincipal, slug: string): Promise<AppRow> => {
    const app = await apps.appBySlug(slug)
    if (!app || app.disabled_at !== null || app.client_id === null || !(await canManageAccount(user, app.owner_id))) return fail(404, 'Not Found')
    return app
  }

  const managedInstallation = async (user: UserPrincipal, id: number): Promise<InstallationRow> => {
    const installation = Number.isSafeInteger(id) ? await apps.installation(id) : null
    if (!installation || !(await canManageAccount(user, installation.account_id))) return fail(404, 'Not Found')
    return installation
  }

  const adminRepositoryIds = async (user: UserPrincipal, account: Account, ids: readonly string[]): Promise<string[]> => {
    const out: string[] = []
    for (const id of ids) {
      const row = await notifications.store.repositoryById(id)
      if (!row || row.owner_id !== account.id) fail(422, `repository ${id} does not belong to ${account.login}`)
      const check = await checkRepositoryAccess(accounts, user, { owner: row!.owner_login, name: row!.name }, 'admin')
      if (check.decision !== 'allow' && !(await accounts.isInstanceAdmin(user.id))) fail(403, `admin access to ${row!.owner_login}/${row!.name} is required`)
      out.push(id)
    }
    return out
  }

  const setHook = async (app: AppRow, input: { readonly url?: unknown; readonly active?: unknown; readonly secret?: unknown }, createdBy: string | null) => {
    const [existing] = await notifications.store.listHooks({ kind: 'app', id: app.id })
    if (!existing && (input.url === undefined || input.url === null || input.url === '')) return
    const parsed = parseHookInput(
      { config: { url: input.url ?? existing?.url, content_type: 'json', ...(input.secret !== undefined ? { secret: input.secret } : {}) }, events: ['*'], ...(input.active !== undefined ? { active: input.active } : {}) },
      existing ?? null,
      { allowInsecureWebhooks: options.allowInsecureWebhooks },
    )
    if (existing) await notifications.store.updateHook(existing.id, parsed)
    else await notifications.store.createHook({ kind: 'app', id: app.id }, parsed, createdBy)
  }

  const ui = {
    managedAccounts,
    managedApp,
    managedInstallation,
    appsOf: async (user: UserPrincipal) => apps.appsOwnedBy((await managedAccounts(user)).map((account) => account.id)),
    installationsOf: async (user: UserPrincipal) => apps.installationsOn((await managedAccounts(user)).map((account) => account.id)),
    installationView: async (user: UserPrincipal, id: number) => {
      const installation = await managedInstallation(user, id)
      const app = (await apps.app(installation.app_id))!
      return {
        installation,
        permissions: JSON.parse(installation.permissions) as AppPermissions,
        repositoryIds: await apps.installationRepositoryIds(installation),
        pendingPermissions: app.permissions !== installation.permissions || app.events !== installation.events,
      }
    },
    keys: (app: AppRow) => apps.keys(app.id),
    generateKey: async (user: UserPrincipal, slug: string) => apps.generateKey((await managedApp(user, slug)).id),
    revokeKey: async (user: UserPrincipal, slug: string, keyId: string) => apps.revokeKey((await managedApp(user, slug)).id, keyId),
    clientSecret: async (user: UserPrincipal, slug: string) => apps.resetClientSecret((await managedApp(user, slug)).id),
    deliveries: async (app: AppRow) => {
      const [hook] = await notifications.store.listHooks({ kind: 'app', id: app.id })
      return hook ? notifications.store.deliveriesFor(hook.id, 20) : []
    },
    redeliver: async (user: UserPrincipal, slug: string, deliveryId: number) => {
      const app = await managedApp(user, slug)
      const [hook] = await notifications.store.listHooks({ kind: 'app', id: app.id })
      const row = await notifications.store.delivery(deliveryId)
      if (!hook || !row || row.hook_id !== hook.id) return fail(404, 'Not Found')
      await notifications.redeliver(row.id)
    },
    hookOf: async (app: AppRow) => (await notifications.store.listHooks({ kind: 'app', id: app.id }))[0] ?? null,
    publicApp: async (slug: string, user: UserPrincipal | null): Promise<AppRow | null> => {
      const app = await apps.appBySlug(slug)
      if (!app || app.disabled_at !== null || app.client_id === null) return null
      return app.public === 1 || (user !== null && (await canManageAccount(user, app.owner_id))) ? app : null
    },

    createApp: async (user: UserPrincipal, ownerLogin: string, input: Parameters<AppsStore['createApp']>[1] & { readonly webhookUrl?: unknown; readonly webhookSecret?: unknown; readonly webhookActive?: unknown }) => {
      const owner = (await managedAccounts(user)).find((account) => account.login.toLowerCase() === ownerLogin.toLowerCase())
      if (!owner) return fail(403, `you cannot create apps for ${ownerLogin}`)
      const events = (input.events as unknown[] | undefined) ?? []
      for (const name of events) if (!isWebhookEventName(name)) fail(422, `unknown event ${String(name)}`)
      const app = await apps.createApp(owner.id, input, { kind: 'user', id: user.id })
      await setHook(app, { url: input.webhookUrl, active: input.webhookActive ?? true, secret: input.webhookSecret }, user.id)
      return app
    },

    updateApp: async (user: UserPrincipal, slug: string, input: Parameters<AppsStore['updateApp']>[1] & { readonly webhookUrl?: unknown; readonly webhookSecret?: unknown; readonly webhookActive?: unknown }) => {
      const app = await managedApp(user, slug)
      for (const name of (input.events as unknown[] | undefined) ?? []) if (!isWebhookEventName(name)) fail(422, `unknown event ${String(name)}`)
      const updated = await apps.updateApp(app.id, input)
      await setHook(updated, { url: input.webhookUrl, active: input.webhookActive, secret: input.webhookSecret }, user.id)
      return updated
    },

    deleteApp: async (user: UserPrincipal, slug: string, baseUrl: string) => {
      const app = await managedApp(user, slug)
      for (const installation of await apps.installationsOf(app.id)) await sendInstallation(baseUrl, installation, 'deleted', user)
      await apps.deleteApp(app.id, { kind: 'user', id: user.id })
    },

    createFromManifest: async (user: UserPrincipal, ownerLogin: string, manifest: ManifestInput) => {
      const app = await ui.createApp(user, ownerLogin, {
        name: manifest.name,
        url: manifest.url,
        description: manifest.description,
        redirectUrl: manifest.redirect_url,
        setupUrl: manifest.setup_url,
        public: manifest.public === true,
        permissions: manifest.default_permissions,
        events: manifest.default_events,
        webhookUrl: manifest.hook_attributes?.url,
        webhookActive: manifest.hook_attributes?.active ?? true,
      })
      return { app, code: await apps.createManifestCode(app.id) }
    },

    install: async (user: UserPrincipal, slug: string, accountLogin: string, selection: 'all' | 'selected', repositoryIds: readonly string[], baseUrl: string) => {
      const app = await ui.publicApp(slug, user)
      if (!app) return fail(404, 'Not Found')
      const account = (await managedAccounts(user)).find((candidate) => candidate.login.toLowerCase() === accountLogin.toLowerCase())
      if (!account) return fail(403, `you cannot install apps on ${accountLogin}`)
      const ids = selection === 'selected' ? await adminRepositoryIds(user, account, repositoryIds) : []
      const installation = await apps.install(app, account.id, selection, ids, user.id)
      await sendInstallation(baseUrl, installation, 'created', user)
      return { app, installation }
    },

    updateInstallation: async (user: UserPrincipal, id: number, selection: 'all' | 'selected', repositoryIds: readonly string[], baseUrl: string) => {
      const installation = await managedInstallation(user, id)
      const account = { id: installation.account_id, login: installation.account_login, kind: installation.account_kind }
      const before = await apps.installationRepositoryIds(installation)
      if (selection !== installation.repository_selection) await apps.setSelection(installation.id, selection)
      if (selection === 'selected') {
        const wanted = await adminRepositoryIds(user, account, repositoryIds)
        const current = installation.repository_selection === 'selected' ? before : []
        await apps.setRepositories(installation.id, wanted.filter((repo) => !current.includes(repo)), current.filter((repo) => !wanted.includes(repo)))
      }
      const updated = (await apps.installation(installation.id))!
      const after = await apps.installationRepositoryIds(updated)
      await sendRepositories(baseUrl, updated, after.filter((repo) => !before.includes(repo)), before.filter((repo) => !after.includes(repo)), user)
      return updated
    },

    acceptPermissions: async (user: UserPrincipal, id: number, baseUrl: string) => {
      const installation = await managedInstallation(user, id)
      const app = (await apps.app(installation.app_id))!
      await apps.acceptPermissions(installation, app)
      await sendInstallation(baseUrl, (await apps.installation(id))!, 'new_permissions_accepted', user)
    },

    suspend: async (user: UserPrincipal, id: number, suspended: boolean, baseUrl: string) => {
      const installation = await managedInstallation(user, id)
      await apps.suspend(installation.id, suspended)
      await sendInstallation(baseUrl, (await apps.installation(id))!, suspended ? 'suspend' : 'unsuspend', user)
    },

    uninstall: async (user: UserPrincipal, id: number, baseUrl: string) => {
      const installation = await managedInstallation(user, id)
      await sendInstallation(baseUrl, installation, 'deleted', user)
      await apps.uninstall(installation.id)
    },
  }

  const requireUser = async (request: Request): Promise<UserPrincipal> => {
    const principal = await options.principal(request)
    if (!principal || principal.kind === 'anonymous') return fail(401, 'Requires authentication')
    if (principal.kind !== 'user') return fail(403, 'Resource not accessible by integration')
    return principal
  }

  const requireApp = async (request: Request): Promise<AppRow> => {
    const header = request.headers.get('Authorization') ?? ''
    const match = /^(?:bearer|token)\s+(\S+)$/i.exec(header.trim())
    const app = match ? await apps.verifyJwt(match[1]!) : null
    if (!app) return fail(401, "A JSON web token could not be decoded")
    return app
  }

  const requireInstallation = async (request: Request): Promise<{ installation: InstallationRow; tokenId: string; repositoryIds: readonly string[] | null }> => {
    const principal = await options.principal(request)
    if (!principal || principal.kind === 'anonymous') return fail(401, 'Bad credentials')
    if (principal.kind !== 'app' || principal.installationId === undefined) return fail(403, 'This endpoint needs an installation access token')
    const installation = await apps.installation(principal.installationId)
    if (!installation) return fail(401, 'Bad credentials')
    return { installation, tokenId: principal.tokenId, repositoryIds: principal.limits.repositoryIds }
  }

  const appInstallation = async (app: AppRow, id: string | undefined): Promise<InstallationRow> => {
    const installation = await apps.installation(Number(id))
    if (!installation || installation.app_id !== app.id) return fail(404, 'Not Found')
    return installation
  }

  const readBody = async (request: Request): Promise<Record<string, unknown>> => {
    const text = await request.text()
    if (text.trim() === '') return {}
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {}
    return fail(400, 'Problems parsing JSON')
  }

  const page = (url: URL) => {
    const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30))
    const number = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1)
    return <T>(items: readonly T[]) => items.slice((number - 1) * perPage, number * perPage)
  }

  const installationByTarget = async (request: Request, app: AppRow, accountId: string | null) => {
    const installation = accountId ? await apps.installationFor(app.id, accountId) : null
    if (!installation) return fail(404, 'Not Found')
    return json(200, installationJson(options.baseUrl(request), installation))
  }

  const appHook = async (app: AppRow) => (await notifications.store.listHooks({ kind: 'app', id: app.id }))[0] ?? fail(404, 'Not Found')

  type Handler = (request: Request, url: URL, params: string[]) => Promise<Response>

  const routes: readonly [string, RegExp, Handler][] = [
    ['GET', /^\/app$/, async (request) => {
      const app = await requireApp(request)
      return json(200, appJson(options.baseUrl(request), app, (await apps.installationsOf(app.id)).length))
    }],
    ['GET', /^\/app\/installations$/, async (request, url) => {
      const app = await requireApp(request)
      return json(200, page(url)(await apps.installationsOf(app.id)).map((installation) => installationJson(options.baseUrl(request), installation)))
    }],
    ['GET', /^\/app\/installations\/(\d+)$/, async (request, _url, [id]) => json(200, installationJson(options.baseUrl(request), await appInstallation(await requireApp(request), id)))],
    ['DELETE', /^\/app\/installations\/(\d+)$/, async (request, _url, [id]) => {
      const app = await requireApp(request)
      const installation = await appInstallation(app, id)
      await notifications.emitToApp(app.id, 'installation', 'deleted', { installation: installationJson(options.baseUrl(request), installation), repositories: [], requester: null }, { id: app.owner_id, login: app.owner_login }, options.baseUrl(request))
      await apps.uninstall(installation.id)
      return new Response(null, { status: 204 })
    }],
    ['PUT', /^\/app\/installations\/(\d+)\/suspended$/, async (request, _url, [id]) => {
      await apps.suspend((await appInstallation(await requireApp(request), id)).id, true)
      return new Response(null, { status: 204 })
    }],
    ['DELETE', /^\/app\/installations\/(\d+)\/suspended$/, async (request, _url, [id]) => {
      await apps.suspend((await appInstallation(await requireApp(request), id)).id, false)
      return new Response(null, { status: 204 })
    }],
    ['POST', /^\/app\/installations\/(\d+)\/access_tokens$/, async (request, _url, [id]) => {
      const installation = await appInstallation(await requireApp(request), id)
      const body = await readBody(request)
      const ids: string[] = []
      if (body.repository_ids !== undefined) {
        if (!Array.isArray(body.repository_ids)) fail(422, 'repository_ids must be a list')
        ids.push(...(body.repository_ids as unknown[]).map(String))
      }
      if (body.repositories !== undefined) {
        if (!Array.isArray(body.repositories)) fail(422, 'repositories must be a list')
        for (const name of body.repositories as unknown[]) {
          const row = await notifications.store.repositoryByName(installation.account_login, String(name))
          if (!row) fail(422, `There is at least one repository that does not exist or is not accessible to the parent installation.`)
          ids.push(row!.id)
        }
      }
      const permissions = body.permissions === undefined ? undefined : parsePermissions(body.permissions)
      const created = await apps.createInstallationToken(installation, { ...(ids.length > 0 ? { repositoryIds: [...new Set(ids)] } : {}), ...(permissions ? { permissions } : {}) })
      const baseUrl = options.baseUrl(request)
      return json(201, {
        token: created.token,
        expires_at: iso(created.expiresAt),
        permissions: created.permissions,
        repository_selection: created.repositoryIds === null ? 'all' : 'selected',
        ...(ids.length > 0 ? { repositories: (await repoRows(created.repositoryIds ?? [])).map((row) => repositoryObject(baseUrl, row, null)) } : {}),
      })
    }],
    ['GET', /^\/repos\/([^/]+)\/([^/]+)\/installation$/, async (request, _url, [owner, name]) => {
      const app = await requireApp(request)
      const row = await notifications.store.repositoryByName(owner!, name!)
      const installation = row ? await apps.installationFor(app.id, row.owner_id) : null
      if (!row || !installation || !(await apps.installationRepositoryIds(installation)).includes(row.id)) return fail(404, 'Not Found')
      return json(200, installationJson(options.baseUrl(request), installation))
    }],
    ['GET', /^\/orgs\/([^/]+)\/installation$/, async (request, _url, [login]) => {
      const app = await requireApp(request)
      const account = await accounts.findAccount(login!)
      return installationByTarget(request, app, account?.kind === 'organization' ? account.id : null)
    }],
    ['GET', /^\/users\/([^/]+)\/installation$/, async (request, _url, [login]) => installationByTarget(request, await requireApp(request), (await accounts.findAccount(login!))?.id ?? null)],
    ['GET', /^\/app\/hook\/config$/, async (request) => json(200, hookConfig(await appHook(await requireApp(request))))],
    ['PATCH', /^\/app\/hook\/config$/, async (request) => {
      const app = await requireApp(request)
      const hook = await appHook(app)
      const body = await readBody(request)
      if (typeof body.url === 'string') {
        const invalid = validateWebhookUrl(body.url, { allowInsecure: options.allowInsecureWebhooks })
        if (invalid) fail(422, `url: ${invalid}`)
      }
      await notifications.store.updateHook(hook.id, parseHookInput({ config: body, events: hookEvents(hook) }, hook, { allowInsecureWebhooks: options.allowInsecureWebhooks }))
      return json(200, hookConfig((await notifications.store.hookById(hook.id))!))
    }],
    ['GET', /^\/app\/hook\/deliveries$/, async (request, url) => {
      const hook = await appHook(await requireApp(request))
      const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30))
      const cursor = url.searchParams.get('cursor')
      return json(200, (await notifications.store.deliveriesFor(hook.id, perPage, cursor ? Number(cursor) : undefined)).map(deliveryJson))
    }],
    ['GET', /^\/app\/hook\/deliveries\/(\d+)$/, async (request, _url, [id]) => {
      const hook = await appHook(await requireApp(request))
      const row = await notifications.store.delivery(Number(id))
      if (!row || row.hook_id !== hook.id) return fail(404, 'Not Found')
      return json(200, {
        ...deliveryJson(row),
        url: row.url,
        request: { headers: row.request_headers ? JSON.parse(row.request_headers) : null, payload: JSON.parse(row.payload) },
        response: { headers: row.response_headers ? JSON.parse(row.response_headers) : null, payload: row.response_body },
      })
    }],
    ['POST', /^\/app\/hook\/deliveries\/(\d+)\/attempts$/, async (request, _url, [id]) => {
      const hook = await appHook(await requireApp(request))
      const row = await notifications.store.delivery(Number(id))
      if (!row || row.hook_id !== hook.id) return fail(404, 'Not Found')
      return json(202, { id: await notifications.redeliver(row.id) })
    }],
    ['POST', /^\/app-manifests\/([^/]+)\/conversions$/, async (request, _url, [code]) => {
      const app = await apps.redeemManifestCode(code!)
      if (!app) return fail(404, 'Not Found')
      const key = await apps.generateKey(app.id)
      const clientSecret = await apps.resetClientSecret(app.id)
      const [hook] = await notifications.store.listHooks({ kind: 'app', id: app.id })
      const webhookSecret = hook ? randomSecret() : null
      if (hook && webhookSecret) await notifications.store.updateHook(hook.id, { ...parseHookInput({}, hook, { allowInsecureWebhooks: true }), secret: webhookSecret })
      return json(201, { ...appJson(options.baseUrl(request), app), client_id: app.client_id, client_secret: clientSecret, webhook_secret: webhookSecret, pem: key.pem })
    }],
    ['GET', /^\/apps\/([^/]+)$/, async (request, _url, [slug]) => {
      const principal = await options.principal(request)
      const app = await ui.publicApp(slug!, principal?.kind === 'user' ? principal : null)
      if (!app) return fail(404, 'Not Found')
      return json(200, appJson(options.baseUrl(request), app))
    }],
    ['GET', /^\/installation\/repositories$/, async (request, url) => {
      const { installation, repositoryIds } = await requireInstallation(request)
      const ids = repositoryIds ?? (await apps.installationRepositoryIds(installation))
      const baseUrl = options.baseUrl(request)
      const rows = await repoRows(ids)
      return json(200, { total_count: rows.length, repository_selection: installation.repository_selection, repositories: page(url)(rows).map((row) => repositoryObject(baseUrl, row, null)) })
    }],
    ['DELETE', /^\/installation\/token$/, async (request) => {
      const { tokenId } = await requireInstallation(request)
      await apps.revokeToken(tokenId)
      return new Response(null, { status: 204 })
    }],
    ['GET', /^\/user\/installations$/, async (request, url) => {
      const user = await requireUser(request)
      const installations = await ui.installationsOf(user)
      return json(200, { total_count: installations.length, installations: page(url)(installations).map((installation) => installationJson(options.baseUrl(request), installation)) })
    }],
    ['GET', /^\/user\/installations\/(\d+)\/repositories$/, async (request, url, [id]) => {
      const installation = await managedInstallation(await requireUser(request), Number(id))
      const rows = await repoRows(await apps.installationRepositoryIds(installation))
      const baseUrl = options.baseUrl(request)
      return json(200, { total_count: rows.length, repository_selection: installation.repository_selection, repositories: page(url)(rows).map((row) => repositoryObject(baseUrl, row, null)) })
    }],
    ['PUT', /^\/user\/installations\/(\d+)\/repositories\/([^/]+)$/, async (request, _url, [id, repositoryId]) => {
      const user = await requireUser(request)
      const installation = await managedInstallation(user, Number(id))
      if (installation.repository_selection === 'all') return fail(422, 'the installation already covers all repositories')
      const current = await apps.installationRepositoryIds(installation)
      await ui.updateInstallation(user, installation.id, 'selected', [...new Set([...current, repositoryId!])], options.baseUrl(request))
      return new Response(null, { status: 204 })
    }],
    ['DELETE', /^\/user\/installations\/(\d+)\/repositories\/([^/]+)$/, async (request, _url, [id, repositoryId]) => {
      const user = await requireUser(request)
      const installation = await managedInstallation(user, Number(id))
      if (installation.repository_selection === 'all') return fail(422, 'switch the installation to selected repositories first')
      const current = await apps.installationRepositoryIds(installation)
      await ui.updateInstallation(user, installation.id, 'selected', current.filter((repo) => repo !== repositoryId), options.baseUrl(request))
      return new Response(null, { status: 204 })
    }],
  ]

  const handle = async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url)
    const match = /^\/api(?:\/v3)?(\/.*?)\/?$/.exec(url.pathname)
    if (!match) return null
    const path = match[1]!
    const candidates = routes.filter(([, pattern]) => pattern.test(path))
    if (candidates.length === 0) return null
    const route = candidates.find(([method]) => method === request.method)
    if (!route) return json(405, { message: 'Method Not Allowed' }, { Allow: candidates.map(([method]) => method).join(', ') })
    try {
      return await route[2](request, url, route[1].exec(path)!.slice(1).map(decodeURIComponent))
    } catch (error) {
      if (error instanceof AppError || error instanceof ApiError) return json(error.status, { message: error.message, documentation_url: 'https://docs.github.com/rest/apps' })
      throw error
    }
  }

  return { handle, ui }
}

export type GitHubApps = ReturnType<typeof createGitHubApps>
