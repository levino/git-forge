import { type Database, sql } from '@git-forge/accounts'
import type { EventActor } from './context.ts'

export type UserSummary = {
  readonly kind: 'user' | 'app' | 'system'
  readonly id: string | null
  readonly login: string
  readonly name: string | null
  readonly email: string | null
}

export const GHOST: UserSummary = { kind: 'user', id: null, login: 'ghost', name: null, email: null }

export const SYSTEM_USER: UserSummary = { kind: 'system', id: null, login: 'git-forge', name: 'git-forge', email: null }

export const EXTERNAL_PREFIX = 'github:'

export const externalUser = (login: string): UserSummary => ({ kind: 'user', id: null, login, name: null, email: null })

export type ActorKey = { readonly kind: string | null; readonly id: string | null }

const key = (actor: ActorKey): string => `${actor.kind}:${actor.id}`

export type UserDirectory = (actor: ActorKey | null | undefined) => UserSummary

export const loadUsers = async (db: Database, actors: readonly (ActorKey | null | undefined)[]): Promise<UserDirectory> => {
  const present = actors.filter((actor): actor is ActorKey => !!actor && actor.id !== null)
  const userIds = [...new Set(present.filter((actor) => actor.kind === 'user').map((actor) => actor.id!))]
  const appIds = [...new Set(present.filter((actor) => actor.kind === 'app').map((actor) => actor.id!))]
  const found = new Map<string, UserSummary>()
  const placeholders = (ids: readonly string[]) => ids.map(() => '?').join(', ')
  if (userIds.length > 0) {
    const rows = await db.all<{ id: string; login: string; display_name: string | null; email: string | null }>(
      sql(`SELECT id, login, display_name, email FROM accounts WHERE id IN (${placeholders(userIds)})`, ...userIds),
    )
    for (const row of rows) found.set(`user:${row.id}`, { kind: 'user', id: row.id, login: row.login, name: row.display_name, email: row.email })
  }
  if (appIds.length > 0) {
    const rows = await db.all<{ id: string; slug: string; name: string }>(sql(`SELECT id, slug, name FROM apps WHERE id IN (${placeholders(appIds)})`, ...appIds))
    for (const row of rows) found.set(`app:${row.id}`, { kind: 'app', id: row.id, login: `${row.slug}[bot]`, name: row.name, email: null })
  }
  return (actor) => {
    if (!actor || actor.id === null) return actor?.kind === 'system' ? SYSTEM_USER : GHOST
    if (actor.id.startsWith(EXTERNAL_PREFIX)) return externalUser(actor.id.slice(EXTERNAL_PREFIX.length))
    return found.get(key(actor)) ?? GHOST
  }
}

export const actorColumns = (actor: EventActor): [string, string | null] => [actor.kind, actor.id]
