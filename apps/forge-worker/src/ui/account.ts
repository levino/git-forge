import { isTokenScope, type TokenScope } from '@git-forge/accounts'
import type { ForgeServices, UiSession } from '../app.ts'

export type AccountAction =
  | { readonly kind: 'token-created'; readonly name: string; readonly token: string }
  | { readonly kind: 'token-revoked' }
  | { readonly kind: 'passkey-removed' }
  | { readonly kind: 'error'; readonly message: string }

const DAY_MS = 24 * 60 * 60 * 1000

export const EXPIRY_DAYS = [7, 30, 90, 365] as const

export const parseExpiry = (value: string | null, now: number): number | null | undefined => {
  if (value === 'never') return null
  const days = Number(value)
  return (EXPIRY_DAYS as readonly number[]).includes(days) ? now + days * DAY_MS : undefined
}

export const accountAction = async (forge: ForgeServices, session: UiSession, form: FormData, now: number): Promise<AccountAction> => {
  const user = session.principal
  const action = form.get('action')
  if (action === 'create-token') {
    const name = String(form.get('name') ?? '').trim()
    const scopes = form.getAll('scopes').map(String)
    const expiresAt = parseExpiry(String(form.get('expires') ?? ''), now)
    if (name === '' || name.length > 100) return { kind: 'error', message: 'Give the token a name of at most 100 characters.' }
    if (scopes.length === 0 || !scopes.every(isTokenScope)) return { kind: 'error', message: 'Choose at least one scope.' }
    if (expiresAt === undefined) return { kind: 'error', message: 'Choose an expiry.' }
    const created = await forge.account.createToken(user, { name, scopes: scopes as TokenScope[], expiresAt })
    return { kind: 'token-created', name, token: created.token }
  }
  if (action === 'revoke-token') {
    return (await forge.account.revokeToken(user, String(form.get('id') ?? ''))) ? { kind: 'token-revoked' } : { kind: 'error', message: 'Unknown token.' }
  }
  if (action === 'remove-passkey') {
    if (!forge.loginOptions.passkeys) return { kind: 'error', message: 'Passkeys are disabled on this instance.' }
    return (await forge.account.revokePasskey(user, String(form.get('id') ?? ''))) ? { kind: 'passkey-removed' } : { kind: 'error', message: 'Unknown passkey.' }
  }
  return { kind: 'error', message: 'Unknown action.' }
}
