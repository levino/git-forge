import { sql } from '@git-forge/accounts'
import { edgeForge } from './forge.ts'
import { type Counter, counting, uncounted, vars } from './runtime.ts'

declare const Bunny: { v1: { serve(handler: (request: Request) => Promise<Response>): void; waitUntil(promise: Promise<unknown>): void } }

type Worker = { fetch(request: Request, env: never, context: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; readonly props?: unknown }): Promise<Response> }

const STATS = 'CREATE TABLE IF NOT EXISTS edge_stats (at INTEGER, method TEXT, path TEXT, status INTEGER, db INTEGER, statements INTEGER, s3 INTEGER, other INTEGER, bg_db INTEGER, bg_statements INTEGER, bg_s3 INTEGER, bg_other INTEGER, ms INTEGER, trace TEXT)'

const record = async (request: Request, status: number, counter: Counter, ms: number): Promise<void> => {
  const { db } = await edgeForge()
  const { bg } = counter
  await db.batch([
    sql(STATS),
    sql('INSERT INTO edge_stats VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', Date.now(), request.method, new URL(request.url).pathname, status, counter.db, counter.statements, counter.s3, counter.other, bg.db, bg.statements, bg.s3, bg.other, ms, counter.trace.join('\n')),
  ])
}

const stats = async (request: Request, key: string): Promise<Response> => {
  if (request.headers.get('authorization') !== `Bearer ${key}`) return new Response('not found\n', { status: 404 })
  const { db } = await edgeForge()
  const rows = await db.all(sql('SELECT rowid AS id, * FROM edge_stats WHERE rowid > ? ORDER BY rowid', Number(new URL(request.url).searchParams.get('since') ?? 0)))
  return Response.json(rows, { headers: { 'cache-control': 'no-store' } })
}

const finished = (response: Response, onDone: () => void): Response => {
  if (!response.body) {
    onDone()
    return response
  }
  const reader = response.body.getReader()
  const body: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (!done) return controller.enqueue(value)
      controller.close()
      onDone()
    },
    async cancel(reason) {
      await reader.cancel(reason)
      onDone()
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export const serve = (worker: Worker): void =>
  Bunny.v1.serve(async (request) => {
    const started = Date.now()
    const key = vars().EDGE_STATS
    if (key && new URL(request.url).pathname === '/_edge/stats') return stats(request, key)
    const pending: Promise<unknown>[] = []
    const context = { waitUntil: (promise: Promise<unknown>) => void pending.push(promise), passThroughOnException: () => undefined, props: {} }
    let done!: () => void
    const complete = new Promise<void>((resolve) => (done = resolve))
    const { counter, result } = counting(async () => {
      const response = await worker.fetch(request, { ...vars(), ASSETS: { fetch: async () => new Response('not found\n', { status: 404 }) } } as never, context)
      Bunny.v1.waitUntil(
        complete.then(async () => {
          const ms = Date.now() - started
          counter.done = true
          await Promise.allSettled(pending)
          await (await edgeForge()).background(counter.enqueued).catch((error: unknown) => console.error(error))
          if (key) await uncounted(() => record(request, response.status, counter, ms)).catch((error: unknown) => console.error(error))
        }),
      )
      return finished(response, done)
    })
    return result
  })
