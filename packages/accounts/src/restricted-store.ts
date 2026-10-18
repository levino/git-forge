import { type Database, sql } from './database.ts'
import { randomId } from './encoding.ts'
import { type Access, atLeast, rank } from './roles.ts'

export const RESTRICTION_ROLES = ['triage', 'write', 'maintain', 'admin'] as const

export type RestrictionRole = (typeof RESTRICTION_ROLES)[number]

export const isRestrictionRole = (value: unknown): value is RestrictionRole => RESTRICTION_ROLES.includes(value as RestrictionRole)

export type RestrictionRule = {
  readonly id: string
  readonly pattern: string | null
  readonly oid: string | null
  readonly role: RestrictionRole
  readonly note: string | null
  readonly createdAt: string
  readonly objects: number
}

export type RestrictedObjectInput = {
  readonly oid: string
  readonly rule: string
  readonly path: string | null
}

type RuleRow = { id: string; pattern: string | null; oid: string | null; role: RestrictionRole; note: string | null; created_at: number; objects: number }

const toRule = (row: RuleRow): RestrictionRule => ({
  id: row.id,
  pattern: row.pattern,
  oid: row.oid,
  role: row.role,
  note: row.note,
  createdAt: new Date(row.created_at).toISOString(),
  objects: row.objects,
})

const strictest = (roles: readonly RestrictionRole[]): RestrictionRole => roles.reduce((a, b) => (rank(b) > rank(a) ? b : a))

export const createRestrictionStore = (db: Database, options: { readonly now?: () => number } = {}) => {
  const now = options.now ?? Date.now
  return {
    createRule: async (repositoryId: string, input: { readonly pattern?: string; readonly oid?: string; readonly role: RestrictionRole; readonly note?: string }): Promise<RestrictionRule> => {
      const id = randomId()
      const at = now()
      await db.run(
        sql(
          'INSERT INTO restriction_rules (id, repository_id, pattern, oid, role, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id,
          repositoryId,
          input.pattern ?? null,
          input.oid ?? null,
          input.role,
          input.note ?? null,
          at,
        ),
      )
      return { id, pattern: input.pattern ?? null, oid: input.oid ?? null, role: input.role, note: input.note ?? null, createdAt: new Date(at).toISOString(), objects: 0 }
    },

    rules: async (repositoryId: string): Promise<RestrictionRule[]> =>
      (
        await db.all<RuleRow>(
          sql(
            `SELECT r.*, (SELECT COUNT(*) FROM restricted_objects o WHERE o.rule_id = r.id) AS objects
             FROM restriction_rules r WHERE r.repository_id = ? ORDER BY r.created_at, r.id`,
            repositoryId,
          ),
        )
      ).map(toRule),

    deleteRule: async (repositoryId: string, id: string): Promise<boolean> => {
      const existing = await db.all(sql('SELECT 1 AS found FROM restriction_rules WHERE id = ? AND repository_id = ?', id, repositoryId))
      if (existing.length === 0) return false
      await db.batch([sql('DELETE FROM restricted_objects WHERE rule_id = ?', id), sql('DELETE FROM restriction_rules WHERE id = ?', id)])
      return true
    },

    recordObjects: async (repositoryId: string, objects: readonly RestrictedObjectInput[]): Promise<void> => {
      if (objects.length === 0) return
      const at = now()
      await db.batch(
        objects.map((object) =>
          sql(
            'INSERT INTO restricted_objects (repository_id, oid, rule_id, path, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repository_id, oid, rule_id) DO NOTHING',
            repositoryId,
            object.oid,
            object.rule,
            object.path,
            at,
          ),
        ),
      )
    },

    requiredRoles: async (repositoryId: string, oids: readonly string[]): Promise<Map<string, RestrictionRole>> => {
      const required = new Map<string, RestrictionRole>()
      if (oids.length === 0) return required
      const unique = [...new Set(oids)]
      const roles = new Map<string, RestrictionRole[]>()
      for (let start = 0; start < unique.length; start += 90) {
        const chunk = unique.slice(start, start + 90)
        const marks = chunk.map(() => '?').join(', ')
        const rows = await db.all<{ oid: string; role: RestrictionRole }>(
          sql(
            `SELECT o.oid AS oid, r.role AS role FROM restricted_objects o JOIN restriction_rules r ON r.id = o.rule_id WHERE o.repository_id = ? AND o.oid IN (${marks})
             UNION ALL SELECT r.oid AS oid, r.role AS role FROM restriction_rules r WHERE r.repository_id = ? AND r.oid IN (${marks})`,
            repositoryId,
            ...chunk,
            repositoryId,
            ...chunk,
          ),
        )
        for (const row of rows) roles.set(row.oid, [...(roles.get(row.oid) ?? []), row.role])
      }
      for (const [oid, list] of roles) required.set(oid, strictest(list))
      return required
    },
  }
}

export type RestrictionStore = ReturnType<typeof createRestrictionStore>

export const mayReadRestricted = (access: Access, required: RestrictionRole): boolean => atLeast(access, required)
