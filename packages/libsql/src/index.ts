import type { BatchResult, Database, Row, SqlValue, Statement } from '@git-forge/accounts'

export type LibsqlConfig = {
  readonly url: string
  readonly authToken?: string
  readonly fetch?: typeof fetch
}

export class LibsqlError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'LibsqlError'
  }
}

type Value =
  | { readonly type: 'null' }
  | { readonly type: 'integer'; readonly value: string }
  | { readonly type: 'float'; readonly value: number }
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'blob'; readonly base64: string }

type StmtResult = {
  readonly cols: readonly { readonly name: string | null }[]
  readonly rows: readonly (readonly Value[])[]
  readonly affected_row_count: number
}

type HranaError = { readonly message: string; readonly code?: string | null }

type StreamResult = { readonly type: 'ok'; readonly response: { readonly type: string; readonly result?: unknown } } | { readonly type: 'error'; readonly error: HranaError }

type HranaBatch = { readonly step_results: readonly (StmtResult | null)[]; readonly step_errors: readonly (HranaError | null)[] }

type Condition = { readonly type: 'ok'; readonly step: number } | { readonly type: 'not'; readonly cond: Condition }

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

export const encodeValue = (value: SqlValue): Value => {
  if (value === null) return { type: 'null' }
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() }
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'integer', value: value.toString() } : { type: 'float', value }
  if (typeof value === 'string') return { type: 'text', value }
  return { type: 'blob', base64: toBase64(value) }
}

export const decodeValue = (value: Value): SqlValue => {
  switch (value.type) {
    case 'null':
      return null
    case 'integer': {
      const big = BigInt(value.value)
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big
    }
    case 'float':
      return value.value
    case 'text':
      return value.value
    case 'blob':
      return fromBase64(value.base64)
  }
}

const stmt = (statement: Statement) => ({ sql: statement.sql, args: statement.params.map(encodeValue) })

const rowsOf = <T extends Row>(result: StmtResult): T[] =>
  result.rows.map((values) => Object.fromEntries(result.cols.map((col, i) => [col.name ?? String(i), decodeValue(values[i]!)])) as T)

const fail = (error: HranaError): never => {
  throw new LibsqlError(error.message, error.code ?? undefined)
}

export const pipelineUrl = (url: string): string => {
  const base = new URL(url.replace(/^libsql:/, 'https:').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'))
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new LibsqlError(`unsupported libSQL URL ${url}`)
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/v2/pipeline`
}

export const libsqlDatabase = (config: LibsqlConfig): Database => {
  const endpoint = pipelineUrl(config.url)
  const send = config.fetch ?? ((input, init) => fetch(input, init))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.authToken) headers.authorization = `Bearer ${config.authToken}`

  const pipeline = async (bodies: readonly unknown[]): Promise<{ readonly type: string; readonly result?: unknown }[]> => {
    const response = await send(endpoint, { method: 'POST', headers, body: JSON.stringify({ baton: null, requests: [...bodies, { type: 'close' }] }) })
    const text = await response.text()
    if (!response.ok) throw new LibsqlError(`libSQL ${response.status}: ${text.slice(0, 500)}`)
    const results = (JSON.parse(text) as { results: StreamResult[] }).results.slice(0, bodies.length)
    if (results.length < bodies.length) throw new LibsqlError('libSQL: incomplete pipeline response')
    return results.map((result) => (result.type === 'error' ? fail(result.error) : result.response))
  }

  const execute = async (statement: Statement): Promise<StmtResult> => (await pipeline([{ type: 'execute', stmt: stmt(statement) }]))[0]!.result as StmtResult

  return {
    all: async <T extends Row>(statement: Statement) => rowsOf<T>(await execute(statement)),
    run: async (statement) => ({ changes: (await execute(statement)).affected_row_count }),
    batch: async (statements): Promise<BatchResult[]> => {
      if (statements.length === 0) return []
      const commit = statements.length + 1
      const steps: { stmt: ReturnType<typeof stmt>; condition?: Condition }[] = [
        { stmt: { sql: 'BEGIN IMMEDIATE', args: [] } },
        ...statements.map((statement, i) => ({ stmt: stmt(statement), condition: { type: 'ok' as const, step: i } })),
        { stmt: { sql: 'COMMIT', args: [] }, condition: { type: 'ok', step: statements.length } },
        { stmt: { sql: 'ROLLBACK', args: [] }, condition: { type: 'not', cond: { type: 'ok', step: commit } } },
      ]
      const result = (await pipeline([{ type: 'batch', batch: { steps } }]))[0]!.result as HranaBatch
      const error = result.step_errors.slice(0, commit + 1).find((entry) => entry !== null)
      if (error) fail(error)
      return result.step_results.slice(1, commit).map((entry) => ({ changes: entry?.affected_row_count ?? 0, rows: entry ? rowsOf(entry) : [] }))
    },
    read: async (statements) =>
      statements.length === 0 ? [] : (await pipeline(statements.map((statement) => ({ type: 'execute', stmt: stmt(statement) })))).map((response) => rowsOf(response.result as StmtResult)),
  }
}
