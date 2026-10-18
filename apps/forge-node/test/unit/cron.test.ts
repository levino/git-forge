import { describe, expect, it } from 'vitest'
import { CronError, nextRun, parseCron } from '../../src/cron.ts'

const next = (expression: string, after: string) => nextRun(parseCron(expression), new Date(after)).toISOString()

describe('cron expressions', () => {
  it('finds the next minute of the Worker schedule in UTC', () => {
    expect(next('17 3 * * *', '2026-10-18T16:52:31Z')).toBe('2026-10-19T03:17:00.000Z')
    expect(next('17 3 * * *', '2026-10-18T03:16:59Z')).toBe('2026-10-18T03:17:00.000Z')
    expect(next('17 3 * * *', '2026-10-18T03:17:00Z')).toBe('2026-10-19T03:17:00.000Z')
  })

  it('supports lists, ranges, steps and aliases', () => {
    expect(next('*/15 * * * *', '2026-10-18T10:16:00Z')).toBe('2026-10-18T10:30:00.000Z')
    expect(next('0 9-17/4 * * *', '2026-10-18T13:00:00Z')).toBe('2026-10-18T17:00:00.000Z')
    expect(next('5,35 * * * *', '2026-10-18T10:06:00Z')).toBe('2026-10-18T10:35:00.000Z')
    expect(next('@hourly', '2026-10-18T10:06:00Z')).toBe('2026-10-18T11:00:00.000Z')
    expect(next('@daily', '2026-12-31T23:59:00Z')).toBe('2027-01-01T00:00:00.000Z')
  })

  it('treats weekday 7 as Sunday and ORs day of month with weekday', () => {
    expect(next('0 0 * * 7', '2026-10-18T00:00:00Z')).toBe('2026-10-25T00:00:00.000Z')
    expect(next('0 0 13 * 5', '2026-10-01T00:00:00Z')).toBe('2026-10-02T00:00:00.000Z')
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z')
  })

  it('rejects malformed expressions and schedules that never fire', () => {
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1/2/3 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError)
    }
    expect(() => next('0 0 31 2 *', '2026-01-01T00:00:00Z')).toThrow(/never fires/)
  })
})
