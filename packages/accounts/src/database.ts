export type SqlValue = string | number | bigint | Uint8Array | null

export type Row = Record<string, SqlValue>

export type Statement = {
  readonly sql: string
  readonly params: readonly SqlValue[]
}

export type RunResult = {
  readonly changes: number
}

export interface Database {
  all<T extends Row = Row>(statement: Statement): Promise<T[]>
  run(statement: Statement): Promise<RunResult>
  batch(statements: readonly Statement[]): Promise<RunResult[]>
}

export const sql = (text: string, ...params: readonly SqlValue[]): Statement => ({ sql: text, params })

export const first = async <T extends Row = Row>(db: Database, statement: Statement): Promise<T | null> => {
  const rows = await db.all<T>(statement)
  return rows[0] ?? null
}

export type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike
  all<T = unknown>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes?: number } }>
}

export type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<{ meta: { changes?: number } }[]>
}

export const d1Database = (d1: D1DatabaseLike): Database => {
  const prepare = (statement: Statement) => d1.prepare(statement.sql).bind(...statement.params)
  return {
    all: async <T extends Row>(statement: Statement) => (await prepare(statement).all<T>()).results,
    run: async (statement) => ({ changes: (await prepare(statement).run()).meta.changes ?? 0 }),
    batch: async (statements) =>
      statements.length === 0 ? [] : (await d1.batch(statements.map(prepare))).map((result) => ({ changes: result.meta.changes ?? 0 })),
  }
}
