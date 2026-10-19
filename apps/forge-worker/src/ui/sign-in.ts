import type { Principal } from '@git-forge/accounts'
import type { ForgeServices, UiSession } from '../app.ts'

export type SignedIn = { readonly session: UiSession | null; readonly principal: Principal; readonly instanceAdmin?: Promise<boolean> }

export const signIn = async (forge: ForgeServices, request: Request): Promise<SignedIn> => {
  const session = await forge.session(request)
  if (session) return { session, principal: session.principal, instanceAdmin: forge.instance.isAdministrator(session.principal).catch(() => false) }
  return { session, principal: (await forge.authenticate(request)) ?? { kind: 'anonymous' } }
}
