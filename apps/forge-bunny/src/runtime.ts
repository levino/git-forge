import { AsyncLocalStorage } from 'node:async_hooks'

export type Tally = { db: number; statements: number; s3: number; other: number }

export type Counter = Tally & { bg: Tally; done: boolean; enqueued: boolean; trace: string[] }

declare const Deno: { env: { toObject(): Record<string, string> } }

export const vars = (): Record<string, string> => Deno.env.toObject()

const counters = new AsyncLocalStorage<Counter>()

export const current = (): Counter | undefined => counters.getStore()

export const counting = <T>(run: () => Promise<T>): { counter: Counter; result: Promise<T> } => {
  const counter: Counter = { db: 0, statements: 0, s3: 0, other: 0, bg: { db: 0, statements: 0, s3: 0, other: 0 }, done: false, enqueued: false, trace: [] }
  return { counter, result: counters.run(counter, run) }
}

export const uncounted = <T>(run: () => Promise<T>): Promise<T> => counters.exit(run)

export const markEnqueued = (): void => {
  const counter = current()
  if (counter) counter.enqueued = true
}

type Pipeline = { requests?: { type: string; stmt?: { sql: string }; batch?: { steps: { stmt: { sql: string } }[] } }[] }

const statementsOf = (body: unknown): string[] => {
  if (typeof body !== 'string') return []
  try {
    return ((JSON.parse(body) as Pipeline).requests ?? []).flatMap((entry) =>
      entry.type === 'execute' && entry.stmt ? [entry.stmt.sql] : entry.type === 'batch' ? (entry.batch?.steps ?? []).map((step) => step.stmt.sql) : [],
    )
  } catch {
    return []
  }
}

export const databaseFetch: typeof fetch = (input, init) => {
  const counter = current()
  if (counter) {
    const statements = statementsOf(init?.body)
    ;(counter.done ? counter.bg : counter).statements += statements.length
    counter.trace.push(`${counter.done ? 'bg ' : ''}db [${statements.map((text) => text.replace(/\s+/g, ' ').slice(0, 110)).join(' ; ')}]`)
  }
  return fetch(input, init)
}

const originalFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const counter = current()
  if (counter) {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const target = counter.done ? counter.bg : counter
    const prefix = counter.done ? 'bg ' : ''
    if (url.hostname.endsWith('bunnydb.net')) target.db++
    else if (url.hostname.endsWith('storage.bunnycdn.com')) {
      target.s3++
      counter.trace.push(`${prefix}s3 ${init?.method ?? (input instanceof Request ? input.method : 'GET')} ${url.pathname.slice(0, 90)}${url.search.slice(0, 40)}`)
    } else {
      target.other++
      counter.trace.push(`${prefix}fetch ${url.host}${url.pathname.slice(0, 60)}`)
    }
  }
  return originalFetch(input, init)
}
