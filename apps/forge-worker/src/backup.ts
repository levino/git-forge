import { type Database, first, SEARCH_INDEX_REBUILD, sql } from '@git-forge/accounts'
import {
  type BackupEntry,
  type BackupLedger,
  type CopyBudget,
  copyObjects,
  copyVerified,
  hashStream,
  type DigestFactory,
  readAll,
  type Storage,
  toHex,
  utf8,
  verifyEntries,
} from '@git-forge/core'

export type BackupJob = { readonly kind: 'backup' }

export type BackupRun = {
  readonly id: string
  readonly startedAt: number
  readonly phase: 'dump' | 'objects'
  readonly table: number
  readonly after: number
  readonly page: number
  readonly cursor: string
  readonly objects: number
  readonly bytes: number
}

export type BackupState = {
  readonly run: BackupRun | null
  readonly last: { readonly id: string; readonly startedAt: number; readonly completedAt: number; readonly objects: number; readonly bytes: number } | null
  readonly error: { readonly at: number; readonly message: string } | null
}

export type BackupStatus = BackupState & {
  readonly enabled: boolean
  readonly lagSeconds: number | null
  readonly stored: { readonly objects: number; readonly bytes: number }
}

export type BackupContext = {
  readonly db: Database
  readonly source: Storage
  readonly target: Storage
  readonly digests: DigestFactory
  readonly now: () => Date
  readonly budget?: CopyBudget
}

export const BACKUP_PREFIX = 'backups/'
export const DUMP_PREFIX = 'backups/db/'
export const CHANGED_PREFIX = 'backups/changed/'
export const DEFAULT_BACKUP_BUDGET: CopyBudget = { maxBytes: 256 * 1024 * 1024, maxKeys: 2000 }

const PAGE_ROWS = 500
const PAGES_PER_STEP = 50
const OPERATIONAL = new Set(['backup_state', 'backup_objects', 'storage_state'])
const EMPTY: BackupState = { run: null, last: null, error: null }

const load = async (db: Database): Promise<{ readonly version: number; readonly state: BackupState }> => {
  const row = await first<{ version: number; state: string }>(db, sql('SELECT version, state FROM backup_state WHERE id = 1'))
  return row ? { version: row.version, state: JSON.parse(row.state) as BackupState } : { version: 0, state: EMPTY }
}

const save = async (db: Database, version: number, state: BackupState): Promise<boolean> =>
  (
    await db.run(
      version === 0
        ? sql('INSERT INTO backup_state (id, version, state) VALUES (1, 1, ?) ON CONFLICT (id) DO NOTHING', JSON.stringify(state))
        : sql('UPDATE backup_state SET version = version + 1, state = ? WHERE id = 1 AND version = ?', JSON.stringify(state), version),
    )
  ).changes === 1

const update = async (db: Database, change: (state: BackupState) => BackupState | null): Promise<BackupState> => {
  for (;;) {
    const { version, state } = await load(db)
    const next = change(state)
    if (!next || (await save(db, version, next))) return next ?? state
  }
}

export const sqlLedger = (db: Database): BackupLedger => ({
  etags: async (keys) =>
    new Map(
      (await db.all<{ path: string; etag: string }>(sql(`SELECT path, etag FROM backup_objects WHERE path IN (${keys.map(() => '?').join(', ')})`, ...keys))).map((row) => [row.path, row.etag]),
    ),
  record: async (entry) => {
    await db.run(
      sql(
        'INSERT INTO backup_objects (path, target, etag, size, sha256) VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET target = excluded.target, etag = excluded.etag, size = excluded.size, sha256 = excluded.sha256',
        entry.key,
        entry.target,
        entry.etag,
        entry.size,
        entry.sha256,
      ),
    )
  },
})

const stamp = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')

const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`

export const sqlLiteral = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'string') return `'${value.replace(/'/g, "''").replace(/\n/g, "'||char(10)||'")}'`
  const bytes = value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : Uint8Array.from(value as number[])
  return `X'${toHex(bytes)}'`
}

type SchemaEntry = { readonly type: string; readonly name: string; readonly tbl_name: string; readonly sql: string }

const schema = (db: Database): Promise<SchemaEntry[]> =>
  db.all<SchemaEntry>(
    sql("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 7) <> 'sqlite_' AND substr(tbl_name, 1, 4) <> '_cf_' ORDER BY rowid"),
  )

const oneLine = (statement: string): string => `${statement.replace(/\s*\n\s*/g, ' ').trim()};\n`

const insert = (table: string, row: Record<string, unknown>): string => {
  const columns = Object.keys(row).filter((column) => column !== '__rowid')
  return `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${columns.map((column) => sqlLiteral(row[column])).join(', ')});\n`
}

const writeFile = async (context: BackupContext, key: string, text: string): Promise<number> => {
  const existing = await context.target.get(key)
  if (existing) {
    const { oid, size } = await hashStream(existing.body, context.digests)
    await sqlLedger(context.db).record({ key, target: key, etag: '', size, sha256: oid })
    return size
  }
  const bytes = utf8(text)
  const digest = context.digests('SHA-256')
  digest.update(bytes)
  await context.target.put(key, bytes, bytes.length)
  await sqlLedger(context.db).record({ key, target: key, etag: '', size: bytes.length, sha256: toHex(await digest.digest()) })
  return bytes.length
}

const VIRTUAL = /^CREATE\s+VIRTUAL\s+TABLE/i
const SHADOW = ['data', 'idx', 'content', 'docsize', 'config']

const classify = (entries: readonly SchemaEntry[]) => {
  const virtual = entries.filter((entry) => entry.type === 'table' && VIRTUAL.test(entry.sql))
  const shadow = new Set(virtual.flatMap((entry) => SHADOW.map((suffix) => `${entry.name}_${suffix}`)))
  const skipped = (name: string) => shadow.has(name) || virtual.some((entry) => entry.name === name)
  return {
    tables: entries.filter((entry) => entry.type === 'table' && !skipped(entry.name)),
    virtual,
    after: (type: string) => entries.filter((entry) => entry.type === type && !skipped(entry.tbl_name)),
  }
}

const dumpStep = async (context: BackupContext, start: BackupRun, budget: CopyBudget): Promise<BackupRun> => {
  const { tables, virtual, after } = classify(await schema(context.db))
  const dir = `${DUMP_PREFIX}${start.id}/`
  let run = start
  if (run.table < 0) {
    await writeFile(context, `${dir}0000-schema.sql`, `PRAGMA defer_foreign_keys = on;\n${tables.map((entry) => oneLine(entry.sql)).join('')}`)
    run = { ...run, table: 0 }
  }
  let bytes = 0
  for (let pages = 0; run.table < tables.length && bytes < budget.maxBytes && pages < PAGES_PER_STEP; ) {
    const table = tables[run.table]!
    if (OPERATIONAL.has(table.name)) {
      run = { ...run, table: run.table + 1, after: 0, page: 0 }
      continue
    }
    const withoutRowid = /WITHOUT\s+ROWID/i.test(table.sql)
    const rows = await context.db.all(
      withoutRowid
        ? sql(`SELECT * FROM ${ident(table.name)} LIMIT ? OFFSET ?`, PAGE_ROWS, run.after)
        : sql(`SELECT rowid AS __rowid, * FROM ${ident(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, run.after, PAGE_ROWS),
    )
    if (rows.length > 0) {
      const name = `${dir}${String(run.table + 1).padStart(4, '0')}-${table.name}-${String(run.page).padStart(6, '0')}.sql`
      bytes += await writeFile(context, name, rows.map((row) => insert(table.name, row)).join(''))
      pages++
    }
    run =
      rows.length < PAGE_ROWS
        ? { ...run, table: run.table + 1, after: 0, page: 0 }
        : { ...run, after: withoutRowid ? run.after + rows.length : Number(rows.at(-1)!.__rowid), page: run.page + 1 }
  }
  if (run.table < tables.length) return run
  const rebuild = virtual.length > 0 ? SEARCH_INDEX_REBUILD.map((statement) => statement.sql) : []
  const statements = [...after('index'), ...virtual].map((entry) => entry.sql).concat(rebuild, [...after('trigger'), ...after('view')].map((entry) => entry.sql))
  await writeFile(context, `${dir}9999-indexes.sql`, statements.map(oneLine).join(''))
  return { ...run, phase: 'objects' }
}

export const startBackup = (db: Database, at: Date): Promise<BackupState> =>
  update(db, (state) =>
    state.run ? null : { ...state, run: { id: stamp(at), startedAt: at.getTime(), phase: 'dump', table: -1, after: 0, page: 0, cursor: '', objects: 0, bytes: 0 } },
  )

export const backupStep = async (context: BackupContext): Promise<boolean> => {
  const { version, state } = await load(context.db)
  const run = state.run
  if (!run) return false
  const budget = context.budget ?? DEFAULT_BACKUP_BUDGET
  try {
    let next: BackupState
    if (run.phase === 'dump') next = { ...state, run: await dumpStep(context, run, budget), error: null }
    else {
      const progress = await copyObjects(context.source, context.target, sqlLedger(context.db), {
        after: run.cursor,
        skip: (key) => key.startsWith('tmp/'),
        rewritten: (key) => `${CHANGED_PREFIX}${run.id}/${key}`,
        budget,
        digests: context.digests,
      })
      const objects = run.objects + progress.objects
      const bytes = run.bytes + progress.bytes
      if (progress.cursor !== null) next = { ...state, run: { ...run, cursor: progress.cursor, objects, bytes }, error: null }
      else {
        const completedAt = context.now().getTime()
        const manifest = { format: 1, id: run.id, startedAt: new Date(run.startedAt).toISOString(), completedAt: new Date(completedAt).toISOString(), objects, bytes }
        await writeFile(context, `${DUMP_PREFIX}${run.id}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)
        next = { run: null, last: { id: run.id, startedAt: run.startedAt, completedAt, objects, bytes }, error: null }
      }
    }
    return (await save(context.db, version, next)) && next.run !== null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update(context.db, (current) => ({ ...current, error: { at: context.now().getTime(), message } }))
    throw error
  }
}

export const backupStatus = async (db: Database, enabled: boolean, now: Date): Promise<BackupStatus> => {
  const { state } = await load(db)
  const stored = await first<{ objects: number; bytes: number }>(db, sql('SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM backup_objects'))
  return {
    ...state,
    enabled,
    lagSeconds: state.last ? Math.max(0, Math.floor((now.getTime() - state.last.startedAt) / 1000)) : null,
    stored: { objects: Number(stored?.objects ?? 0), bytes: Number(stored?.bytes ?? 0) },
  }
}

export const verifyBackup = async (db: Database, target: Storage, digests: DigestFactory, sample: number): Promise<{ readonly checked: number; readonly failures: string[] }> => {
  const entries = await db.all<BackupEntry>(sql('SELECT path AS key, target, etag, size, sha256 FROM backup_objects ORDER BY random() LIMIT ?', sample))
  return { checked: entries.length, failures: await verifyEntries(target, entries, digests) }
}

const MANIFEST = /^backups\/db\/([^/]+)\/manifest\.json$/

export const completeBackups = async (target: Storage): Promise<string[]> => {
  const ids: string[] = []
  for await (const info of target.list(DUMP_PREFIX)) {
    const match = MANIFEST.exec(info.key)
    if (match) ids.push(match[1]!)
  }
  return ids
}

const readText = async (storage: Storage, key: string): Promise<string> => {
  const object = await storage.get(key)
  if (!object) throw new Error(`${key} is missing`)
  return new TextDecoder().decode(await readAll(object.body))
}

export async function* dumpFiles(target: Storage, id: string): AsyncIterable<string> {
  if (!(await target.head(`${DUMP_PREFIX}${id}/manifest.json`))) throw new Error(`backup ${id} is not complete`)
  const keys: string[] = []
  for await (const info of target.list(`${DUMP_PREFIX}${id}/`)) if (info.key.endsWith('.sql')) keys.push(info.key)
  for (const key of keys) yield await readText(target, key)
}

export type RestoreResult = { readonly id: string; readonly statements: number; readonly objects: number; readonly bytes: number }

export const restoreBackup = async (target: Storage, storage: Storage, db: Database, digests: DigestFactory, id?: string): Promise<RestoreResult> => {
  const chosen = id ?? (await completeBackups(target)).at(-1)
  if (!chosen) throw new Error('the backup target has no complete backup')
  if ((await schema(db)).some((entry) => entry.type === 'table')) throw new Error('restore needs an empty database')
  let statements = 0
  await db.run(sql('PRAGMA foreign_keys = OFF'))
  for await (const text of dumpFiles(target, chosen)) {
    const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('PRAGMA '))
    for (let i = 0; i < lines.length; i += 100) await db.batch(lines.slice(i, i + 100).map((line) => sql(line)))
    statements += lines.length
  }
  await db.run(sql('PRAGMA foreign_keys = ON'))
  let objects = 0
  let bytes = 0
  const copy = async (from: string, to: string) => {
    const entry = await copyVerified(target, storage, from, to, digests)
    objects++
    bytes += entry?.size ?? 0
  }
  for await (const info of target.list('')) if (!info.key.startsWith(BACKUP_PREFIX) && !info.key.startsWith('tmp/')) await copy(info.key, info.key)
  for await (const info of target.list(CHANGED_PREFIX)) {
    const [run, ...rest] = info.key.slice(CHANGED_PREFIX.length).split('/')
    if (run! <= chosen) await copy(info.key, rest.join('/'))
  }
  return { id: chosen, statements, objects, bytes }
}

export async function* restoreSql(target: Storage, id?: string): AsyncIterable<Uint8Array> {
  const chosen = id ?? (await completeBackups(target)).at(-1)
  if (!chosen) throw new Error('the backup target has no complete backup')
  for await (const text of dumpFiles(target, chosen)) yield utf8(text)
}
