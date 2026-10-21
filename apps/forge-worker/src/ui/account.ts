import { isTokenScope } from '@git-forge/accounts'
import { ForgeError, type ForgeServices, type UiSession } from '../app.ts'

export type AccountAction =
  | { readonly kind: 'token-created'; readonly name: string; readonly token: string }
  | { readonly kind: 'token-revoked' }
  | { readonly kind: 'passkey-removed' }
  | { readonly kind: 'identity-unlinked' }
  | { readonly kind: 'session-revoked' }
  | { readonly kind: 'agent-revoked' }
  | { readonly kind: 'renamed'; readonly login: string }
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
    const scope = form.get('scope')
    const expiresAt = parseExpiry(String(form.get('expires') ?? ''), now)
    if (name === '' || name.length > 100) return { kind: 'error', message: 'Give the token a name of at most 100 characters.' }
    if (!isTokenScope(scope)) return { kind: 'error', message: 'Choose the access: read, write or admin.' }
    if (expiresAt === undefined) return { kind: 'error', message: 'Choose an expiry.' }
    const created = await forge.account.createToken(user, { name, scopes: [scope], expiresAt })
    return { kind: 'token-created', name, token: created.token }
  }
  if (action === 'revoke-token') {
    return (await forge.account.revokeToken(user, String(form.get('id') ?? ''))) ? { kind: 'token-revoked' } : { kind: 'error', message: 'Unknown token.' }
  }
  if (action === 'remove-passkey') {
    if (!(await forge.loginMethods()).passkeys) return { kind: 'error', message: 'Passkeys are disabled on this instance.' }
    return (await forge.account.revokePasskey(user, String(form.get('id') ?? ''))) ? { kind: 'passkey-removed' } : { kind: 'error', message: 'Unknown passkey.' }
  }
  if (action === 'unlink-identity') {
    try {
      return (await forge.account.unlinkIdentity(user, String(form.get('issuer') ?? ''), String(form.get('subject') ?? ''))) ? { kind: 'identity-unlinked' } : { kind: 'error', message: 'Unknown linked account.' }
    } catch (error) {
      if (error instanceof ForgeError) return { kind: 'error', message: error.message }
      throw error
    }
  }
  if (action === 'rename') {
    try {
      return { kind: 'renamed', login: (await forge.renameAccount(user, user.login, String(form.get('login') ?? '').trim())).login }
    } catch (error) {
      if (error instanceof ForgeError) return { kind: 'error', message: error.message }
      throw error
    }
  }
  if (action === 'revoke-session') {
    return (await forge.account.revokeSession(user, String(form.get('id') ?? ''))) ? { kind: 'session-revoked' } : { kind: 'error', message: 'Unknown session.' }
  }
  if (action === 'revoke-agent') {
    return (await forge.account.revokeAgent(user, String(form.get('id') ?? ''))) ? { kind: 'agent-revoked' } : { kind: 'error', message: 'Unknown agent.' }
  }
  return { kind: 'error', message: 'Unknown action.' }
}
