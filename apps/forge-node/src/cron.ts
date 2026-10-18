export type CronSchedule = {
  readonly source: string
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  readonly anyDay: boolean
  readonly anyWeekday: boolean
}

export class CronError extends Error {}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
}

const number = (text: string, field: string): number => {
  if (!/^\d+$/.test(text)) throw new CronError(`invalid ${field} value ${JSON.stringify(text)}`)
  return Number(text)
}

const parseField = (text: string, field: string, min: number, max: number): Set<number> => {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined]
    if (part.split('/').length > 2) throw new CronError(`invalid ${field} ${JSON.stringify(part)}`)
    const step = stepText === undefined ? 1 : number(stepText, field)
    if (step < 1) throw new CronError(`invalid ${field} step ${JSON.stringify(part)}`)
    let start: number
    let end: number
    if (range === '*') {
      start = min
      end = max
    } else if (range.includes('-')) {
      const [from, to, ...rest] = range.split('-')
      if (rest.length > 0) throw new CronError(`invalid ${field} range ${JSON.stringify(range)}`)
      start = number(from!, field)
      end = number(to!, field)
    } else {
      start = number(range, field)
      end = stepText === undefined ? start : max
    }
    if (start < min || end > max || start > end) throw new CronError(`${field} ${JSON.stringify(part)} is outside ${min}-${max}`)
    for (let value = start; value <= end; value += step) values.add(value)
  }
  return values
}

export const parseCron = (expression: string): CronSchedule => {
  const source = expression.trim()
  const fields = (ALIASES[source] ?? source).split(/\s+/)
  if (fields.length !== 5) throw new CronError(`a cron expression has five fields (minute hour day month weekday), got ${JSON.stringify(expression)}`)
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string]
  const weekdays = parseField(weekday, 'weekday', 0, 7)
  if (weekdays.delete(7)) weekdays.add(0)
  return {
    source,
    minutes: parseField(minute, 'minute', 0, 59),
    hours: parseField(hour, 'hour', 0, 23),
    days: parseField(day, 'day', 1, 31),
    months: parseField(month, 'month', 1, 12),
    weekdays,
    anyDay: day.startsWith('*'),
    anyWeekday: weekday.startsWith('*'),
  }
}

const dayMatches = (schedule: CronSchedule, date: Date): boolean => {
  if (!schedule.months.has(date.getUTCMonth() + 1)) return false
  const day = schedule.days.has(date.getUTCDate())
  const weekday = schedule.weekdays.has(date.getUTCDay())
  if (schedule.anyDay && schedule.anyWeekday) return true
  if (schedule.anyDay) return weekday
  if (schedule.anyWeekday) return day
  return day || weekday
}

const MINUTE = 60_000
const LIMIT = 5 * 366 * 24 * 60

export const nextRun = (schedule: CronSchedule, after: Date): Date => {
  const time = new Date(Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE)
  for (let steps = 0; steps < LIMIT; steps++) {
    if (!dayMatches(schedule, time)) {
      time.setUTCHours(24, 0, 0, 0)
      continue
    }
    if (!schedule.hours.has(time.getUTCHours())) {
      time.setUTCHours(time.getUTCHours() + 1, 0, 0, 0)
      continue
    }
    if (schedule.minutes.has(time.getUTCMinutes())) return time
    time.setTime(time.getTime() + MINUTE)
  }
  throw new CronError(`${schedule.source} never fires`)
}
