import { type Database, first, sql } from '@git-forge/accounts'
import { openValue, type SealedSecret, sealValue, type SecretsKey } from '@git-forge/actions'
import type { RepositoryName } from '@git-forge/core'

export type MirrorSecretKind = 'token' | 'webhook'

export type MirrorSecrets = {
  readonly available: boolean
  readonly get: (repo: RepositoryName, remote: string, kind: MirrorSecretKind) => Promise<string | null>
  readonly put: (repo: RepositoryName, remote: string, kind: MirrorSecretKind, value: string) => Promise<void>
  readonly seal: (context: readonly string[], value: string) => Promise<SealedSecret>
  readonly open: (context: readonly string[], sealed: SealedSecret) => Promise<string>
}

export class MirrorSecretsUnavailableError extends Error {
  constructor() {
    super('storing mirror credentials needs ACTIONS_SECRETS_KEY')
  }
}

type Row = { key_id: string; iv: string; ciphertext: string }

const context = (repo: RepositoryName, remote: string, kind: MirrorSecretKind) => ['git-forge-mirror-secret', repo.owner.toLowerCase(), repo.name.toLowerCase(), remote, kind]

export const createMirrorSecrets = (db: Database, key: SecretsKey | undefined, now: () => number): MirrorSecrets => {
  const required = (): SecretsKey => {
    if (!key) throw new MirrorSecretsUnavailableError()
    return key
  }
  return {
    available: key !== undefined,
    get: async (repo, remote, kind) => {
      if (!key) return null
      const row = await first<Row>(db, sql('SELECT key_id, iv, ciphertext FROM mirror_secrets WHERE owner = ? AND repo = ? AND remote = ? AND kind = ?', repo.owner, repo.name, remote, kind))
      return row ? openValue(key, context(repo, remote, kind), { keyId: row.key_id, iv: row.iv, ciphertext: row.ciphertext }) : null
    },
    put: async (repo, remote, kind, value) => {
      const sealed = await sealValue(required(), context(repo, remote, kind), value)
      const at = now()
      await db.run(
        sql(
          'INSERT INTO mirror_secrets (owner, repo, remote, kind, key_id, iv, ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, repo, remote, kind) DO UPDATE SET key_id = excluded.key_id, iv = excluded.iv, ciphertext = excluded.ciphertext, updated_at = excluded.updated_at',
          repo.owner,
          repo.name,
          remote,
          kind,
          sealed.keyId,
          sealed.iv,
          sealed.ciphertext,
          at,
          at,
        ),
      )
    },
    seal: (data, value) => sealValue(required(), data, value),
    open: (data, sealed) => openValue(required(), data, sealed),
  }
}
