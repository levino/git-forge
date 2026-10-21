import { AsyncLocalStorage } from 'node:async_hooks'
import { applyMigrations, createStateCache, type Database, MIGRATIONS, requestScope, type ScopeState } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { MemoryStorage } from '@git-forge/core'
import { createForge, type Forge, type ForgeOptions } from '../../src/app.ts'
import { DEFAULT_MAX_LFS_OBJECT_BYTES } from '../../src/config.ts'

export const BOOTSTRAP_TOKEN = 'bootstrap-secret'

export type NodeForge = Forge & { readonly storage: MemoryStorage; readonly db: Database }

export type NodeForgeSetup = { readonly locks?: boolean; readonly windowMs?: number }

export const nodeForge = async (overrides: Partial<ForgeOptions> = {}, setup: NodeForgeSetup = {}): Promise<NodeForge> => {
  const storage = new MemoryStorage()
  const opened = overrides.db ?? openSqliteDatabase().db
  if (!overrides.db) await applyMigrations(opened, MIGRATIONS)
  const scope = requestScope(new AsyncLocalStorage<ScopeState>(), setup.windowMs ?? 0)
  const db = scope.database(opened)
  const forge = createForge({
    storage,
    stateCache: createStateCache(db, setup.locks ? { locks: {} } : {}),
    publicUrl: undefined,
    instanceKey: undefined,
    bootstrapToken: BOOTSTRAP_TOKEN,
    maxPushBytes: 1024 * 1024,
    packfileUriBase: undefined,
    compactMaxBytes: 0,
    maxLfsObjectBytes: DEFAULT_MAX_LFS_OBJECT_BYTES,
    mirrorIntervalMinutes: 30,
    allowInsecureFederation: false,
    allowPrivateRemotes: true,
    deepCheckDays: 0,
    mirrorUnitBytes: 0,
    ...overrides,
    db,
    requestScope: scope,
  })
  return { ...forge, storage, db }
}

export const call = (forge: Forge, base: string, method: string, path: string, token?: string, body?: unknown): Promise<Response> =>
  forge.fetch(
    new Request(`${base}${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )

export const bootstrap = async (forge: Forge, base: string, login = 'admin'): Promise<string> => {
  const response = await call(forge, base, 'POST', '/api/bootstrap', BOOTSTRAP_TOKEN, { login })
  if (response.status !== 201) throw new Error(`bootstrap failed with ${response.status}: ${await response.text()}`)
  return ((await response.json()) as { token: string }).token
}
