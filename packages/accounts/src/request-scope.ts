import type { Database, Row, Statement } from './database.ts'

export type ContextStorage<T> = { run<R>(store: T, callback: () => R): R; getStore(): T | undefined }

type Pending = { readonly statement: Statement; readonly resolve: (rows: Row[]) => void; readonly reject: (error: unknown) => void }

type Memo = { readonly rows: Promise<Row[]>; readonly tables: ReadonlySet<string> }

export type ScopeState = { readonly memo: Map<string, Memo>; readonly pending: Map<Database, Pending[]> }

export type RequestScope = {
  readonly database: (db: Database) => Database
  readonly run: <T>(callback: () => Promise<T>) => Promise<T>
  readonly fresh: <T>(callback: () => Promise<T>) => Promise<T>
}

export const REMOTE_WINDOW_MS = 5

export const READ_STATEMENT = /^\s*(SELECT|WITH)\b/i

const TABLE = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_]*)/gi

const TARGET = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([A-Za-z_][A-Za-z0-9_]*)/i

const tablesOf = (text: string): ReadonlySet<string> => new Set([...text.matchAll(TABLE)].map((match) => match[1]!.toLowerCase()))

const keyOf = (statement: Statement): string =>
  JSON.stringify([statement.sql, statement.params.map((value) => (typeof value === 'bigint' ? `${value}n` : value instanceof Uint8Array ? [...value] : value))])

const newState = (): ScopeState => ({ memo: new Map(), pending: new Map() })

export const requestScope = (context: ContextStorage<ScopeState> | null, windowMs = 0): RequestScope => {
  const current = () => context?.getStore()
  const flush = (db: Database, state: ScopeState) => {
    const batch = state.pending.get(db) ?? []
    state.pending.delete(db)
    db.read(batch.map((entry) => entry.statement)).then(
      (results) => batch.forEach((entry, i) => entry.resolve(results[i] ?? [])),
      (error: unknown) => batch.forEach((entry) => entry.reject(error)),
    )
  }
  const queue = (db: Database, state: ScopeState, statement: Statement) =>
    new Promise<Row[]>((resolve, reject) => {
      const pending = state.pending.get(db)
      if (pending) return void pending.push({ statement, resolve, reject })
      state.pending.set(db, [{ statement, resolve, reject }])
      setTimeout(() => flush(db, state), windowMs)
    })
  const reading = (db: Database, state: ScopeState, statement: Statement): Promise<Row[]> => {
    if (!statement.reuse) return queue(db, state, statement)
    const key = keyOf(statement)
    const known = state.memo.get(key)
    if (known) return known.rows
    const entry = { rows: queue(db, state, statement), tables: tablesOf(statement.sql) }
    state.memo.set(key, entry)
    entry.rows.catch(() => state.memo.get(key) === entry && state.memo.delete(key))
    return entry.rows
  }
  const invalidate = (state: ScopeState, statements: readonly Statement[]) => {
    const targets = statements.filter((statement) => !READ_STATEMENT.test(statement.sql)).map((statement) => TARGET.exec(statement.sql)?.[1]?.toLowerCase())
    if (targets.some((target) => target === undefined)) return state.memo.clear()
    for (const [key, entry] of state.memo) if (targets.some((target) => entry.tables.has(target!))) state.memo.delete(key)
  }
  const writing = async <T>(state: ScopeState | undefined, statements: readonly Statement[], write: () => Promise<T>): Promise<T> => {
    if (state) invalidate(state, statements)
    try {
      return await write()
    } finally {
      if (state) invalidate(state, statements)
    }
  }
  return {
    database: (db) => ({
      all: async <T extends Row>(statement: Statement) => {
        const state = current()
        if (!state) return db.all<T>(statement)
        if (!READ_STATEMENT.test(statement.sql)) return writing(state, [statement], () => db.all<T>(statement))
        return [...(await reading(db, state, statement))] as T[]
      },
      run: (statement) => writing(current(), [statement], () => db.run(statement)),
      batch: (statements) => writing(current(), statements, () => db.batch(statements)),
      read: (statements) => {
        const state = current()
        return state ? Promise.all(statements.map(async (statement) => [...(await reading(db, state, statement))])) : db.read(statements)
      },
    }),
    run: (callback) => (!context || current() ? callback() : context.run(newState(), callback)),
    fresh: (callback) => (context ? context.run(newState(), callback) : callback()),
  }
}
