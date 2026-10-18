import { InstanceAdministrationError } from '@git-forge/accounts'
import type { ImportState, MirrorStatus } from '@git-forge/core'
import { formatBytes } from './format.ts'
import { AdminError } from '../admin/operations.ts'
import type { ForgeServices, UiSession } from '../app.ts'

export type AdminOutcome = { readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

export const adminAction = async (forge: ForgeServices, session: UiSession, form: FormData): Promise<AdminOutcome> => {
  const principal = session.principal
  const instance = forge.instance
  try {
    switch (text(form, 'action')) {
      case 'add-admin':
        await instance.setAdmin(principal, text(form, 'login'), true)
        return { kind: 'ok', message: `${text(form, 'login')} is now an instance admin.` }
      case 'remove-admin':
        await instance.setAdmin(principal, text(form, 'login'), false)
        return { kind: 'ok', message: `${text(form, 'login')} is no longer an instance admin.` }
      case 'trust': {
        const trusted = await instance.trust(principal, text(form, 'issuer'), text(form, 'thumbprint') || null)
        return { kind: 'ok', message: `${trusted.issuer} is now trusted.` }
      }
      case 'distrust':
        await instance.distrust(principal, text(form, 'issuer'))
        return { kind: 'ok', message: `${text(form, 'issuer')} is no longer trusted.` }
      case 'check-update': {
        const view = await instance.checkUpdate(principal)
        return view.release?.error ? { kind: 'error', status: 502, message: `Could not check for releases: ${view.release.error}` } : { kind: 'ok', message: view.newer ? `git-forge ${view.release!.latest!.version} is available.` : 'This is the latest release.' }
      }
      case 'update': {
        const { version, commitUrl } = await instance.update(principal)
        return { kind: 'ok', message: `Committed the pin for ${version}${commitUrl ? ` (${commitUrl})` : ''}. Workers Builds deploys it in a few minutes.` }
      }
      case 'connect-repository':
        return { kind: 'ok', message: `Updates commit to ${await instance.setUpdateRepository(principal, { repository: text(form, 'repository'), token: text(form, 'token') })}.` }
      case 'disconnect-repository':
        await instance.clearUpdateRepository(principal)
        return { kind: 'ok', message: 'The instance repository and its token were removed.' }
      case 'retry-job':
        await instance.retryJob(principal, text(form, 'id'))
        return { kind: 'ok', message: 'The job was queued again.' }
      case 'recount-usage':
        return { kind: 'ok', message: `Counting the storage of ${await instance.recountUsage(principal)} repositories.` }
      case 'save-oidc': {
        const saved = await instance.saveOidc(principal, { issuer: text(form, 'issuer'), clientId: text(form, 'client-id'), clientSecret: text(form, 'client-secret'), name: text(form, 'name') })
        return { kind: 'ok', message: `Sign-in with ${saved.name || saved.issuer} is configured.` }
      }
      case 'clear-oidc':
        await instance.clearOidc(principal)
        return { kind: 'ok', message: 'OIDC sign-in was removed.' }
      default:
        return { kind: 'error', status: 400, message: 'Unknown action.' }
    }
  } catch (error) {
    if (error instanceof InstanceAdministrationError || error instanceof AdminError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}

export type ClaimOutcome = { readonly kind: 'claimed'; readonly login: string; readonly invitePath: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

export const handleClaim = async (forge: ForgeServices, request: Request): Promise<ClaimOutcome> => {
  const form = await request.formData()
  const email = text(form, 'email')
  try {
    const claim = await forge.instance.claim(text(form, 'token'), { login: text(form, 'login'), ...(email ? { email } : {}) }, 'invite')
    return { kind: 'claimed', login: claim.login, invitePath: claim.invitePath! }
  } catch (error) {
    if (error instanceof AdminError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}

export const importProgress = (state: ImportState): string => {
  const parts = [state.commits > 0 ? `${state.position} of ${state.commits} commits` : null, state.fetched.bytes > 0 ? `${formatBytes(state.fetched.bytes)} fetched` : null]
  if (state.lfs) parts.push(`LFS: ${state.lfsQueue.length + (state.lfsPending?.length ?? 0)} left, ${state.lfsMissing.length} missing`)
  return parts.filter(Boolean).join(', ')
}

export const usd = (value: number): string => `$${value < 10 ? value.toFixed(2) : Math.round(value)}`

export const handleAdminPost = async (forge: ForgeServices, request: Request): Promise<AdminOutcome> => {
  const session = await forge.verifySessionWrite(request)
  if (!session) return { kind: 'error', status: 403, message: 'The form expired or you are not signed in. Reload the page and try again.' }
  return adminAction(forge, session, await request.formData())
}

export type MirrorHealth = { readonly label: string; readonly badge: string }

export const mirrorHealth = (detached: boolean, status: MirrorStatus | null): MirrorHealth => {
  if (detached) return { label: 'Detached', badge: 'badge-ghost' }
  if (status && status.alarms.length > 0) return { label: `${status.alarms.length} alarm${status.alarms.length === 1 ? '' : 's'}`, badge: 'badge-warning' }
  if (status?.lastRun?.ok === false) return { label: 'Last sync failed', badge: 'badge-error' }
  if (status?.lastDeepCheck && !status.lastDeepCheck.ok) return { label: 'Deep check failed', badge: 'badge-error' }
  if (status?.lastSuccessAt) return { label: 'Synced', badge: 'badge-success' }
  return { label: 'Not synced yet', badge: 'badge-ghost' }
}
