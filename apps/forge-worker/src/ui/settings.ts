import type { ForgeServices, UiSession } from '../app.ts'
import { ForgeError } from '../app.ts'
import type { RepositoryName } from '@git-forge/core'

export type SettingsOutcome = { readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

const list = (value: string): string[] =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')

export const protectionBody = (form: FormData): Record<string, unknown> => {
  const on = (name: string) => form.get(name) === 'on'
  const approvals = Number(text(form, 'approvals') || '1')
  return {
    allow_force_pushes: on('allow_force_pushes'),
    allow_deletions: on('allow_deletions'),
    enforce_admins: on('enforce_admins'),
    required_pull_request_reviews: on('require_reviews')
      ? { required_approving_review_count: approvals, dismiss_stale_reviews: on('dismiss_stale_reviews'), require_last_push_approval: on('require_last_push_approval') }
      : null,
    required_status_checks: on('require_checks') ? { strict: on('strict'), contexts: list(text(form, 'contexts')) } : null,
    restrictions: on('restrict_pushes') ? { users: list(text(form, 'push_users')), teams: list(text(form, 'push_teams')), apps: [], roles: list(text(form, 'push_roles')) } : null,
  }
}

export const settingsAction = async (forge: ForgeServices, session: UiSession, repo: RepositoryName, form: FormData, issuer: string): Promise<SettingsOutcome> => {
  const principal = session.principal
  const settings = forge.settings
  try {
    switch (text(form, 'action')) {
      case 'visibility':
        await settings.setVisibility(principal, repo, text(form, 'visibility'))
        return { kind: 'ok', message: 'Visibility changed.' }
      case 'collaborator':
        await settings.setCollaborator(principal, repo, text(form, 'login'), text(form, 'role'))
        return { kind: 'ok', message: `Access for ${text(form, 'login')} saved.` }
      case 'remove-collaborator':
        await settings.removeCollaborator(principal, repo, text(form, 'login'))
        return { kind: 'ok', message: `${text(form, 'login')} removed.` }
      case 'protection':
        await settings.setBranchProtection(principal, repo, text(form, 'pattern'), protectionBody(form))
        return { kind: 'ok', message: `Protection for ${text(form, 'pattern')} saved.` }
      case 'remove-protection':
        await settings.deleteBranchProtection(principal, repo, text(form, 'pattern'))
        return { kind: 'ok', message: `Protection for ${text(form, 'pattern')} removed.` }
      case 'grant-instance':
        await settings.grantInstance(principal, repo, text(form, 'issuer'))
        return { kind: 'ok', message: `${text(form, 'issuer')} may now read this repository.` }
      case 'revoke-instance':
        await settings.revokeInstance(principal, repo, text(form, 'issuer'))
        return { kind: 'ok', message: `${text(form, 'issuer')} can no longer read this repository.` }
      case 'add-mirror': {
        const remote = text(form, 'remote')
        await settings.addMirror(principal, repo, {
          url: text(form, 'url'),
          ...(remote !== '' ? { remote } : {}),
          mode: text(form, 'mode') === 'manual' ? 'manual' : 'auto',
          auth: text(form, 'auth') === 'instance' ? 'instance' : 'none',
          lfs: form.get('lfs') === 'on',
        })
        return { kind: 'ok', message: 'Mirror configured; the first sync is on its way.' }
      }
      case 'sync-mirror': {
        const result = await settings.syncMirror(principal, repo, text(form, 'remote'), issuer)
        return result.status === 'failed' ? { kind: 'error', status: 502, message: `Sync failed: ${result.error ?? 'unknown error'}` } : { kind: 'ok', message: 'Mirror synced.' }
      }
      case 'verify-mirror': {
        const check = await settings.verifyMirror(principal, repo, text(form, 'remote'))
        return check.ok ? { kind: 'ok', message: 'Deep check passed.' } : { kind: 'error', status: 409, message: `Deep check found problems: ${check.problems.join('; ')}` }
      }
      case 'detach-mirror':
        await settings.detachMirror(principal, repo, text(form, 'remote'))
        return { kind: 'ok', message: 'Mirror detached; its refs are now ordinary branches.' }
      default:
        return { kind: 'error', status: 400, message: 'Unknown action.' }
    }
  } catch (error) {
    if (error instanceof ForgeError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}
