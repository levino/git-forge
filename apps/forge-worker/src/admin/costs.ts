export const CLOUDFLARE_PRICES = {
  workersPlanUsd: 5,
  workersIncludedRequests: 10_000_000,
  workersUsdPerMillionRequests: 0.3,
  r2UsdPerGbMonth: 0.015,
  r2IncludedGb: 10,
  r2ClassAUsdPerMillion: 4.5,
  r2IncludedClassA: 1_000_000,
  r2ClassBUsdPerMillion: 0.36,
  r2IncludedClassB: 10_000_000,
  d1RowsReadUsdPerMillion: 0.001,
  d1IncludedRowsRead: 25_000_000_000,
  d1RowsWrittenUsdPerMillion: 1,
  d1IncludedRowsWritten: 50_000_000,
  d1RowsPerRead: 20,
  d1RowsPerWrite: 2,
} as const

export type UsageMetric = 'requests' | 'r2_class_a' | 'r2_class_b' | 'd1_reads' | 'd1_writes'

export type CostLine = { readonly item: string; readonly quantity: string; readonly usd: number }

export type CostEstimate = { readonly lines: readonly CostLine[]; readonly totalUsd: number; readonly monthFraction: number }

const GB = 1024 ** 3

const MONTH_MS = 30 * 24 * 60 * 60 * 1000

export const monthKey = (at: number): string => new Date(at).toISOString().slice(0, 7)

export const monthFraction = (at: number): number => {
  const start = Date.parse(`${monthKey(at)}-01T00:00:00Z`)
  return Math.min(1, Math.max(1 / 30, (at - start) / MONTH_MS))
}

const over = (value: number, included: number, perMillion: number): number => (Math.max(0, value - included) / 1_000_000) * perMillion

const millions = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} M` : `${Math.round(value).toLocaleString('en')}`)

export const estimateMonthlyCost = (storedBytes: number, counted: Partial<Record<UsageMetric, number>>, at: number): CostEstimate => {
  const p = CLOUDFLARE_PRICES
  const fraction = monthFraction(at)
  const month = (metric: UsageMetric) => (counted[metric] ?? 0) / fraction
  const gb = storedBytes / GB
  const requests = month('requests')
  const classA = month('r2_class_a')
  const classB = month('r2_class_b')
  const rowsRead = month('d1_reads') * p.d1RowsPerRead
  const rowsWritten = month('d1_writes') * p.d1RowsPerWrite
  const lines: CostLine[] = [
    { item: 'Workers Paid plan', quantity: '1', usd: p.workersPlanUsd },
    { item: 'Workers requests', quantity: millions(requests), usd: over(requests, p.workersIncludedRequests, p.workersUsdPerMillionRequests) },
    { item: 'R2 storage', quantity: `${gb.toFixed(2)} GB`, usd: Math.max(0, gb - p.r2IncludedGb) * p.r2UsdPerGbMonth },
    { item: 'R2 class A operations', quantity: millions(classA), usd: over(classA, p.r2IncludedClassA, p.r2ClassAUsdPerMillion) },
    { item: 'R2 class B operations', quantity: millions(classB), usd: over(classB, p.r2IncludedClassB, p.r2ClassBUsdPerMillion) },
    { item: 'D1 rows read', quantity: millions(rowsRead), usd: over(rowsRead, p.d1IncludedRowsRead, p.d1RowsReadUsdPerMillion) },
    { item: 'D1 rows written', quantity: millions(rowsWritten), usd: over(rowsWritten, p.d1IncludedRowsWritten, p.d1RowsWrittenUsdPerMillion) },
  ]
  return { lines, totalUsd: lines.reduce((sum, line) => sum + line.usd, 0), monthFraction: fraction }
}
