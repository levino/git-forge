import { importSecretsKey, openSecret, type SealedSecret, sealSecret, type SecretsKey } from '@git-forge/actions'
import { type Database, first, sql, toHex, utf8 } from '@git-forge/accounts'

export type InstanceSettings = {
  readonly get: <T>(name: string) => Promise<T | null>
  readonly set: (name: string, value: unknown) => Promise<void>
  readonly remove: (name: string) => Promise<void>
  readonly canSeal: () => Promise<boolean>
  readonly seal: (name: string, value: string) => Promise<string>
  readonly open: (name: string, sealed: string) => Promise<string | null>
  readonly secret: (name: string) => Promise<string | null>
  readonly setSecret: (name: string, value: string) => Promise<void>
}

export const deriveSettingsKey = async (secret: string): Promise<SecretsKey> => {
  const material = await crypto.subtle.importKey('raw', utf8(secret), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8('git-forge instance settings') }, material, 256)
  return importSecretsKey(toHex(new Uint8Array(bits)))
}

const SCOPE = { owner: '', repo: '', environment: 'instance' }

export const createInstanceSettings = (db: Database, key: () => Promise<SecretsKey | null>, now: () => number): InstanceSettings => {
  const get = async <T>(name: string): Promise<T | null> => {
    const row = await first<{ value: string }>(db, sql('SELECT value FROM instance_settings WHERE name = ?', name))
    return row ? (JSON.parse(row.value) as T) : null
  }
  const set = async (name: string, value: unknown): Promise<void> => {
    await db.run(sql('INSERT INTO instance_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', name, JSON.stringify(value), now()))
  }
  const seal = async (name: string, value: string): Promise<string> => {
    const sealing = await key()
    if (!sealing) throw new Error('no key to encrypt secrets: set ACTIONS_SECRETS_KEY or BOOTSTRAP_TOKEN')
    return JSON.stringify(await sealSecret(sealing, SCOPE, name, value))
  }
  const open = async (name: string, sealed: string): Promise<string | null> => {
    const opening = await key()
    if (!opening) return null
    try {
      return await openSecret(opening, SCOPE, name, JSON.parse(sealed) as SealedSecret)
    } catch {
      return null
    }
  }
  return {
    get,
    set,
    remove: async (name) => void (await db.run(sql('DELETE FROM instance_settings WHERE name = ?', name))),
    canSeal: async () => (await key()) !== null,
    seal,
    open,
    secret: async (name) => {
      const sealed = await get<string>(name)
      return sealed === null ? null : open(name, sealed)
    },
    setSecret: async (name, value) => set(name, await seal(name, value)),
  }
}
