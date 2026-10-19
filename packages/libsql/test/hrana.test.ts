import { sql } from '@git-forge/accounts'
import { describe, expect, it } from 'vitest'
import { decodeValue, encodeValue, LibsqlError, libsqlDatabase, pipelineUrl } from '../src/index.ts'

const recording = (results: unknown[], status = 200) => {
  const calls: { url: string; headers: Record<string, string>; body: { requests: unknown[] } }[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ baton: null, results }), { status })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

const ok = (result: unknown) => ({ type: 'ok', response: { type: 'execute', result } })

describe('libSQL over Hrana HTTP', () => {
  it('maps libsql:// and ws URLs to the HTTP pipeline endpoint', () => {
    expect(pipelineUrl('libsql://forge-acme.turso.io')).toBe('https://forge-acme.turso.io/v2/pipeline')
    expect(pipelineUrl('wss://db.example/')).toBe('https://db.example/v2/pipeline')
    expect(pipelineUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/v2/pipeline')
    expect(() => pipelineUrl('file:forge.db')).toThrow(LibsqlError)
  })

  it('round-trips every SQL value type', () => {
    for (const value of [null, 0, -7, 2.5, 'text', 2n ** 62n, new Uint8Array([0, 255, 7])]) expect(decodeValue(encodeValue(value))).toEqual(value)
    expect(encodeValue(3)).toEqual({ type: 'integer', value: '3' })
    expect(decodeValue({ type: 'integer', value: '42' })).toBe(42)
  })

  it('sends one execute with the bearer token and maps rows by column name', async () => {
    const { calls, fetch } = recording([ok({ cols: [{ name: 'id' }, { name: 'login' }], rows: [[{ type: 'integer', value: '1' }, { type: 'text', value: 'anna' }]], affected_row_count: 0 }), { type: 'ok', response: { type: 'close' } }])
    const db = libsqlDatabase({ url: 'libsql://db.example', authToken: 'secret', fetch })
    expect(await db.all(sql('SELECT id, login FROM accounts WHERE login = ?', 'anna'))).toEqual([{ id: 1, login: 'anna' }])
    expect(calls[0]!.url).toBe('https://db.example/v2/pipeline')
    expect(calls[0]!.headers.authorization).toBe('Bearer secret')
    expect(calls[0]!.body.requests).toEqual([{ type: 'execute', stmt: { sql: 'SELECT id, login FROM accounts WHERE login = ?', args: [{ type: 'text', value: 'anna' }] } }, { type: 'close' }])
  })

  it('runs a batch as one transaction and reports the first failing step', async () => {
    const { calls, fetch } = recording([
      { type: 'ok', response: { type: 'batch', result: { step_results: [{}, null, null, null, {}], step_errors: [null, { message: 'SQLite error: UNIQUE constraint failed: t.a' }, null, null, null] } } },
    ])
    const db = libsqlDatabase({ url: 'https://db.example', fetch })
    await expect(db.batch([sql('INSERT INTO t VALUES (1)'), sql('INSERT INTO t VALUES (2)')])).rejects.toThrow(/UNIQUE constraint failed/)
    const steps = (calls[0]!.body.requests[0] as { batch: { steps: { stmt: { sql: string }; condition?: unknown }[] } }).batch.steps
    expect(steps.map((step) => step.stmt.sql)).toEqual(['BEGIN IMMEDIATE', 'INSERT INTO t VALUES (1)', 'INSERT INTO t VALUES (2)', 'COMMIT', 'ROLLBACK'])
    expect(steps[4]!.condition).toEqual({ type: 'not', cond: { type: 'ok', step: 3 } })
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  it('throws on HTTP and statement errors', async () => {
    await expect(libsqlDatabase({ url: 'https://db.example', fetch: recording([], 401).fetch }).run(sql('SELECT 1'))).rejects.toThrow(/libSQL 401/)
    await expect(libsqlDatabase({ url: 'https://db.example', fetch: recording([{ type: 'error', error: { message: 'no such table: x', code: 'SQLITE_ERROR' } }]).fetch }).run(sql('SELECT * FROM x'))).rejects.toMatchObject({ code: 'SQLITE_ERROR' })
  })
})
