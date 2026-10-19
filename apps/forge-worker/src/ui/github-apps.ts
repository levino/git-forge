import { AccountsError, APP_PERMISSIONS, AppError, type AppRow } from '@git-forge/accounts'
import { ApiError, WEBHOOK_EVENTS } from '@git-forge/notifications'
import type { ForgeServices, UiSession } from '../app.ts'
import { parseManifest } from '../github-apps.ts'

export type AppOutcome =
  | { readonly kind: 'ok'; readonly message: string; readonly secret?: { readonly label: string; readonly value: string } }
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'error'; readonly status: number; readonly message: string }

export const APP_EVENT_CHOICES = WEBHOOK_EVENTS.filter((name) => name !== 'installation' && name !== 'installation_repositories' && name !== 'mirror_alarm')

export const PERMISSION_CHOICES = APP_PERMISSIONS.filter((name) => name !== 'metadata')

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

const appInput = (form: FormData) => {
  const permissions: Record<string, string> = {}
  for (const name of PERMISSION_CHOICES) {
    const level = text(form, `permission:${name}`)
    if (level === 'read' || level === 'write') permissions[name] = level
  }
  return {
    name: text(form, 'name'),
    description: text(form, 'description'),
    url: text(form, 'url'),
    setupUrl: text(form, 'setup_url'),
    redirectUrl: text(form, 'redirect_url'),
    public: form.get('public') === 'on',
    permissions,
    events: form.getAll('events').map(String),
    webhookUrl: text(form, 'webhook_url'),
    webhookActive: form.get('webhook_active') === 'on',
    ...(text(form, 'webhook_secret') ? { webhookSecret: text(form, 'webhook_secret') } : {}),
  }
}

const withRedirect = (target: string, params: Record<string, string>): string => {
  const url = new URL(target)
  for (const [name, value] of Object.entries(params)) if (value) url.searchParams.set(name, value)
  return url.toString()
}

export const appAction = async (forge: ForgeServices, session: UiSession, form: FormData, baseUrl: string, context: { readonly slug?: string; readonly installation?: number } = {}): Promise<AppOutcome> => {
  const user = session.principal
  const apps = forge.githubApps
  try {
    switch (text(form, 'action')) {
      case 'create': {
        const app = await apps.createApp(user, text(form, 'owner'), appInput(form))
        return { kind: 'redirect', location: `/settings/apps/${app.slug}` }
      }
      case 'manifest': {
        const manifest = parseManifest(text(form, 'manifest'))
        const { app, code } = await apps.createFromManifest(user, text(form, 'owner'), manifest)
        const target = typeof manifest.redirect_url === 'string' && manifest.redirect_url ? manifest.redirect_url : null
        return { kind: 'redirect', location: target ? withRedirect(target, { code, state: text(form, 'state') }) : `/settings/apps/${app.slug}` }
      }
      case 'update':
        await apps.updateApp(user, context.slug!, appInput(form))
        return { kind: 'ok', message: 'App saved.' }
      case 'generate-key': {
        const key = await apps.generateKey(user, context.slug!)
        return { kind: 'ok', message: `Private key ${key.fingerprint} generated.`, secret: { label: 'Private key (PEM), shown once', value: key.pem } }
      }
      case 'revoke-key': {
        await apps.revokeKey(user, context.slug!, text(form, 'key'))
        return { kind: 'ok', message: 'Key revoked.' }
      }
      case 'client-secret': {
        return { kind: 'ok', message: 'New client secret generated.', secret: { label: 'Client secret, shown once', value: await apps.clientSecret(user, context.slug!) } }
      }
      case 'redeliver':
        await apps.redeliver(user, context.slug!, Number(text(form, 'delivery')))
        return { kind: 'ok', message: 'Delivery queued again.' }
      case 'delete':
        await apps.deleteApp(user, context.slug!, baseUrl)
        return { kind: 'redirect', location: '/settings/apps' }
      case 'install': {
        const selection = text(form, 'selection') === 'selected' ? 'selected' : 'all'
        const { app, installation } = await apps.install(user, context.slug!, text(form, 'account'), selection, form.getAll('repositories').map(String), baseUrl)
        return { kind: 'redirect', location: app.setup_url ? withRedirect(app.setup_url, { installation_id: String(installation.id), setup_action: 'install' }) : `/settings/installations/${installation.id}` }
      }
      case 'repositories': {
        const selection = text(form, 'selection') === 'selected' ? 'selected' : 'all'
        await apps.updateInstallation(user, context.installation!, selection, form.getAll('repositories').map(String), baseUrl)
        return { kind: 'ok', message: 'Repository access saved.' }
      }
      case 'accept':
        await apps.acceptPermissions(user, context.installation!, baseUrl)
        return { kind: 'ok', message: 'New permissions accepted.' }
      case 'suspend':
      case 'unsuspend':
        await apps.suspend(user, context.installation!, text(form, 'action') === 'suspend', baseUrl)
        return { kind: 'ok', message: text(form, 'action') === 'suspend' ? 'Installation suspended.' : 'Installation resumed.' }
      case 'uninstall':
        await apps.uninstall(user, context.installation!, baseUrl)
        return { kind: 'redirect', location: '/settings/apps' }
      default:
        return { kind: 'error', status: 400, message: 'Unknown action.' }
    }
  } catch (error) {
    if (error instanceof AppError || error instanceof ApiError) return { kind: 'error', status: error.status, message: error.message }
    if (error instanceof AccountsError) return { kind: 'error', status: 422, message: error.message }
    throw error
  }
}

export const handleAppPost = async (forge: ForgeServices, request: Request, context: { readonly slug?: string; readonly installation?: number } = {}): Promise<AppOutcome> => {
  const session = await forge.verifySessionWrite(request)
  if (!session) return { kind: 'error', status: 403, message: 'The form expired or you are not signed in. Reload the page and try again.' }
  return appAction(forge, session, await request.formData(), forge.issuer(request), context)
}

export type NewAppState = { readonly outcome: AppOutcome | null; readonly manifest: string | null; readonly manifestName: string }

export const newAppRequest = async (forge: ForgeServices, request: Request): Promise<NewAppState> => {
  if (request.method !== 'POST') return { outcome: null, manifest: null, manifestName: '' }
  const form = await request.clone().formData()
  if (form.get('action') !== null || typeof form.get('manifest') !== 'string') return { outcome: await handleAppPost(forge, request), manifest: null, manifestName: '' }
  const manifest = String(form.get('manifest'))
  try {
    return { outcome: null, manifest, manifestName: String((JSON.parse(manifest) as { name?: unknown }).name ?? '') }
  } catch {
    return { outcome: { kind: 'error', status: 422, message: 'The manifest is not valid JSON.' }, manifest: null, manifestName: '' }
  }
}

export const appPermissions = (app: AppRow): Record<string, string> => JSON.parse(app.permissions) as Record<string, string>

export const appEvents = (app: AppRow): string[] => JSON.parse(app.events) as string[]
