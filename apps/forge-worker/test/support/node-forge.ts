import { applyMigrations, MIGRATIONS } from '@git-forge/accounts'
import { openSqliteDatabase } from '@git-forge/accounts-node'
import { MemoryStorage } from '@git-forge/core'
import { createForge, type Forge, type ForgeOptions } from '../../src/app.ts'
import { DEFAULT_MAX_LFS_OBJECT_BYTES } from '../../src/config.ts'

export const BOOTSTRAP_TOKEN = 'bootstrap-secret'

export type NodeForge = Forge & { readonly storage: MemoryStorage }

export const nodeForge = async (overrides: Partial<ForgeOptions> = {}): Promise<NodeForge> => {
  const storage = new MemoryStorage()
  const { db } = openSqliteDatabase()
  await applyMigrations(db, MIGRATIONS)
  const forge = createForge({
    storage,
    db,
    publicUrl: undefined,
    instanceKey: undefined,
    bootstrapToken: BOOTSTRAP_TOKEN,
    maxPushBytes: 1024 * 1024,
    packfileUriBase: undefined,
    compactMaxBytes: 0,
    maxLfsObjectBytes: DEFAULT_MAX_LFS_OBJECT_BYTES,
    mirrorIntervalMinutes: 30,
    allowInsecureFederation: false,
    deepCheckDays: 0,
    mirrorUnitBytes: 0,
    ...overrides,
  })
  return { ...forge, storage }
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
