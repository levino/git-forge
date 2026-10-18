import { InstanceAdministrationError } from '@git-forge/accounts'
import type { MirrorStatus } from '@git-forge/core'
import { ForgeError, type ForgeServices, type UiSession } from '../app.ts'

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
      case 'rename-account': {
        const renamed = await forge.renameAccount(principal, text(form, 'from'), text(form, 'login'))
        return { kind: 'ok', message: `${text(form, 'from')} is now ${renamed.login}.` }
      }
      case 'distrust':
        await instance.distrust(principal, text(form, 'issuer'))
        return { kind: 'ok', message: `${text(form, 'issuer')} is no longer trusted.` }
      case 'backup-run':
        await instance.backup.run(principal)
        return { kind: 'ok', message: 'Backup started.' }
      case 'backup-verify': {
        const result = await instance.backup.verify(principal, 20)
        return result.failures.length === 0
          ? { kind: 'ok', message: `Verified ${result.checked} backed-up objects.` }
          : { kind: 'error', status: 409, message: `Backup verification failed: ${result.failures.join('; ')}` }
      }
      default:
        return { kind: 'error', status: 400, message: 'Unknown action.' }
    }
  } catch (error) {
    if (error instanceof InstanceAdministrationError || error instanceof ForgeError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}

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
