export const ROLES = ['read', 'triage', 'write', 'maintain', 'admin'] as const

export type Role = (typeof ROLES)[number]

export type Access = 'none' | Role

export const ACCESS_LEVELS: readonly Access[] = ['none', ...ROLES]

export const isRole = (value: unknown): value is Role => typeof value === 'string' && (ROLES as readonly string[]).includes(value)

export const rank = (access: Access): number => ACCESS_LEVELS.indexOf(access)

export const atLeast = (access: Access, required: Access): boolean => rank(access) >= rank(required)

export const maxAccess = (...levels: readonly (Access | null | undefined)[]): Access =>
  levels.reduce<Access>((best, level) => (level && rank(level) > rank(best) ? level : best), 'none')

export const minAccess = (a: Access, b: Access): Access => (rank(a) <= rank(b) ? a : b)
