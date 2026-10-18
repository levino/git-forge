import { type Database, first, sql, utf8 } from '@git-forge/accounts'
import { normalizeSecretName, SecretNameError, type SecretScope } from './secrets.ts'

export type Variable = {
  readonly name: string
  readonly value: string
  readonly created_at: number
  readonly updated_at: number
}

export const MAX_VARIABLE_BYTES = 48 * 1024

const SCOPE = 'owner = ? AND repo = ? AND environment = ?'

const scopeArgs = (scope: SecretScope) => [scope.owner, scope.repo, scope.environment] as const

export const putVariable = async (db: Database, scope: SecretScope, name: string, value: string, now: number): Promise<void> => {
  if (utf8(value).length > MAX_VARIABLE_BYTES) throw new SecretNameError(`variable values are limited to ${MAX_VARIABLE_BYTES} bytes`)
  await db.run(
    sql(
      'INSERT INTO actions_variables (owner, repo, environment, name, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner, repo, environment, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ...scopeArgs(scope),
      normalizeSecretName(name),
      value,
      now,
      now,
    ),
  )
}

export const getVariable = async (db: Database, scope: SecretScope, name: string): Promise<Variable | null> =>
  first<Variable>(db, sql(`SELECT name, value, created_at, updated_at FROM actions_variables WHERE ${SCOPE} AND name = ?`, ...scopeArgs(scope), name.toUpperCase()))

export const listVariables = async (db: Database, scope: SecretScope): Promise<Variable[]> =>
  db.all<Variable>(sql(`SELECT name, value, created_at, updated_at FROM actions_variables WHERE ${SCOPE} ORDER BY name`, ...scopeArgs(scope)))

export const deleteVariable = async (db: Database, scope: SecretScope, name: string): Promise<boolean> =>
  (await db.run(sql(`DELETE FROM actions_variables WHERE ${SCOPE} AND name = ?`, ...scopeArgs(scope), name.toUpperCase()))).changes === 1

export const readVariables = async (db: Database, owner: string, repo: string, environment: string | null = null): Promise<Record<string, string>> => {
  const rows = await db.all<Variable & { readonly environment: string }>(
    sql("SELECT environment, name, value FROM actions_variables WHERE owner = ? AND repo = ? AND environment IN ('', ?) ORDER BY environment", owner, repo, environment ?? ''),
  )
  return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}
