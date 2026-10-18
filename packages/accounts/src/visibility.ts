import { pathReach, type ReadView, type Surface, widest } from '@git-forge/core'
import { type Database, sql } from './database.ts'
import { ruleAudience } from './listing.ts'
import type { Principal } from './permissions.ts'
import { compileBranchPattern } from './protection.ts'

export const VISIBILITY_AUDIENCES = ['public', 'user', 'team', 'instance'] as const

export type VisibilityAudience = (typeof VISIBILITY_AUDIENCES)[number]

export type VisibilityRule = {
  readonly id: string
  readonly refs: string
  readonly path: string | null
  readonly audience: VisibilityAudience
  readonly subject: string | null
  readonly createdAt: number
}

type RuleRow = { id: string; refs: string; path: string | null; audience: VisibilityAudience; subject: string | null; created_at: number }

const SELECT_RULES = 'SELECT v.id, v.refs, v.path, v.audience, v.subject, v.created_at FROM visibility_rules v'

const toRule = (row: RuleRow): VisibilityRule => ({ id: row.id, refs: row.refs, path: row.path, audience: row.audience, subject: row.subject, createdAt: row.created_at })

export const repositoryVisibilityRules = async (db: Database, repositoryId: string): Promise<VisibilityRule[]> =>
  (await db.all<RuleRow>(sql(`${SELECT_RULES} WHERE v.repository_id = ? ORDER BY v.created_at, v.id`, repositoryId))).map(toRule)

export const matchingVisibilityRules = async (db: Database, principal: Principal, repositoryId: string, surface: Surface = 'git'): Promise<VisibilityRule[]> => {
  const audience = ruleAudience(principal, surface)
  const rows = await db.all<RuleRow>(
    sql(`${SELECT_RULES} JOIN repositories r ON r.id = v.repository_id JOIN accounts a ON a.id = r.owner_id WHERE v.repository_id = ? AND (${audience.sql})`, repositoryId, ...audience.params),
  )
  return rows.map(toRule)
}

export const compileView = (rules: readonly Pick<VisibilityRule, 'refs' | 'path'>[]): ReadView | null => {
  if (rules.length === 0) return null
  const compiled = rules.map((rule) => ({ pattern: compileBranchPattern(rule.refs), path: rule.path }))
  return { reach: (ref, path) => widest(compiled.filter((rule) => rule.pattern.test(ref)).map((rule) => pathReach(rule.path, path))) }
}

export const visibilityProblem = (refs: unknown, path: unknown): string | null => {
  if (typeof refs !== 'string' || !refs.startsWith('refs/')) return 'refs must be a ref pattern starting with refs/'
  try {
    compileBranchPattern(refs)
  } catch (error) {
    return (error as Error).message
  }
  if (path === null || path === undefined) return null
  if (typeof path !== 'string' || path.length > 1024 || path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || segment.includes('\0'))) {
    return 'path must be a relative path without empty, . or .. segments'
  }
  return null
}
