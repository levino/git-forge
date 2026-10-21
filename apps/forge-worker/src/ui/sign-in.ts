import type { Principal } from '@git-forge/accounts'
import { isValidName, readRefs } from '@git-forge/core'
import type { ForgeServices, UiSession } from '../app.ts'

export type SignedIn = { readonly session: UiSession | null; readonly principal: Principal; readonly instanceAdmin?: Promise<boolean> }

const prefetchRepository = (forge: ForgeServices, request: Request): void => {
  const [, owner, name] = new URL(request.url).pathname.split('/')
  if (!owner || !name || !isValidName(owner) || !isValidName(name)) return
  forge.store
    .findRepository(owner, name)
    .then((repository) => repository && readRefs(forge.storage, { owner: repository.owner, name: repository.name }))
    .catch(() => undefined)
}

export const signIn = async (forge: ForgeServices, request: Request): Promise<SignedIn> => {
  prefetchRepository(forge, request)
  const session = await forge.session(request)
  if (session) return { session, principal: session.principal, instanceAdmin: forge.instance.isAdministrator(session.principal).catch(() => false) }
  return { session, principal: (await forge.authenticate(request)) ?? { kind: 'anonymous' } }
}
