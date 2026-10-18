import { FederationError, normalizeIssuer } from './federation.ts'
import type { Principal, UserPrincipal } from './permissions.ts'
import type { AccountsStore } from './store.ts'

export class InstanceAdministrationError extends Error {
  constructor(
    readonly status: 401 | 403 | 404 | 422,
    message: string,
  ) {
    super(message)
  }
}

export type InstanceAdministrationStore = Pick<AccountsStore, 'findAccount' | 'isInstanceAdmin' | 'setInstanceAdmin' | 'listInstanceAdmins' | 'listTrustedInstances' | 'trustInstance' | 'distrustInstance'>

export type InstanceView = {
  readonly admins: readonly { readonly id: string; readonly login: string }[]
  readonly trustedInstances: readonly { readonly issuer: string; readonly pinnedThumbprint: string | null; readonly createdAt: number }[]
}

export const canAdministerInstance = (principal: Principal, instanceAdmin: boolean): principal is UserPrincipal =>
  principal.kind === 'user' && (principal.limits === null || principal.limits.ceiling === 'admin') && instanceAdmin

export const createInstanceAdministration = (store: InstanceAdministrationStore) => {
  const administrator = async (principal: Principal): Promise<UserPrincipal> => {
    if (principal.kind !== 'user') throw new InstanceAdministrationError(401, 'authentication required')
    if (!canAdministerInstance(principal, await store.isInstanceAdmin(principal.id))) throw new InstanceAdministrationError(403, 'instance admin required')
    return principal
  }

  const issuerOf = (value: string): string => {
    try {
      return normalizeIssuer(value)
    } catch (error) {
      if (error instanceof FederationError) throw new InstanceAdministrationError(422, error.message)
      throw error
    }
  }

  const actor = (user: UserPrincipal) => ({ kind: 'user', id: user.id }) as const

  return {
    isAdministrator: async (principal: Principal): Promise<boolean> => principal.kind === 'user' && canAdministerInstance(principal, await store.isInstanceAdmin(principal.id)),

    view: async (principal: Principal): Promise<InstanceView> => {
      await administrator(principal)
      const [admins, trustedInstances] = await Promise.all([store.listInstanceAdmins(), store.listTrustedInstances()])
      return { admins, trustedInstances }
    },

    setAdmin: async (principal: Principal, login: string, admin: boolean): Promise<void> => {
      const user = await administrator(principal)
      const account = await store.findAccount(login)
      if (!account || account.kind !== 'user') throw new InstanceAdministrationError(404, `user ${login} not found`)
      if (!admin) {
        const admins = await store.listInstanceAdmins()
        if (admins.length === 1 && admins[0]!.id === account.id) throw new InstanceAdministrationError(422, 'an instance needs at least one admin')
      }
      await store.setInstanceAdmin(account.id, admin, actor(user))
    },

    trust: async (principal: Principal, issuer: string, pinnedThumbprint: string | null): Promise<{ readonly issuer: string; readonly pinnedThumbprint: string | null }> => {
      const user = await administrator(principal)
      const normalized = issuerOf(issuer)
      const pin = pinnedThumbprint === null || pinnedThumbprint.trim() === '' ? null : pinnedThumbprint.trim()
      await store.trustInstance({ issuer: normalized, pinnedThumbprint: pin }, actor(user))
      return { issuer: normalized, pinnedThumbprint: pin }
    },

    distrust: async (principal: Principal, issuer: string): Promise<void> => {
      const user = await administrator(principal)
      await store.distrustInstance(issuerOf(issuer), actor(user))
    },
  }
}

export type InstanceAdministration = ReturnType<typeof createInstanceAdministration>
