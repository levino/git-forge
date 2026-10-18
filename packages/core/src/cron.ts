export type CronSchedule = {
  readonly minutes: ReadonlySet<number>
  readonly hours: ReadonlySet<number>
  readonly days: ReadonlySet<number>
  readonly months: ReadonlySet<number>
  readonly weekdays: ReadonlySet<number>
  readonly anyDay: boolean
  readonly anyWeekday: boolean
}

export class CronError extends Error {}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

type Field = { readonly name: string; readonly min: number; readonly max: number; readonly names?: readonly string[]; readonly offset?: number }

const FIELDS: readonly Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS, offset: 0 },
]

const value = (text: string, field: Field): number => {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1
  const number = named >= 0 ? named + (field.offset ?? 0) : /^\d+$/.test(text) ? Number(text) : Number.NaN
  if (!Number.isInteger(number) || number < field.min || number > field.max) throw new CronError(`invalid ${field.name} "${text}"`)
  return number
}

const parseField = (text: string, field: Field): Set<number> => {
  const result = new Set<number>()
  for (const part of text.split(',')) {
    const [range, stepText] = part.split('/') as [string, string | undefined]
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new CronError(`invalid step in "${part}"`)
    let start: number
    let end: number
    if (range === '*') {
      start = field.min
      end = field.max
    } else if (range.includes('-')) {
      const [from, to] = range.split('-') as [string, string]
      start = value(from, field)
      end = value(to, field)
      if (end < start) throw new CronError(`invalid range "${range}"`)
    } else {
      start = value(range, field)
      end = stepText === undefined ? start : field.max
    }
    for (let n = start; n <= end; n += step) result.add(n)
  }
  return result
}

export const parseCron = (expression: string): CronSchedule => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) throw new CronError(`cron "${expression}" must have five fields`)
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]
  if (weekdays.has(7)) weekdays.add(0)
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' }
}

const dayMatches = (schedule: CronSchedule, date: Date): boolean => {
  const day = schedule.days.has(date.getUTCDate())
  const weekday = schedule.weekdays.has(date.getUTCDay())
  if (schedule.anyDay || schedule.anyWeekday) return day && weekday
  return day || weekday
}

export const cronMatches = (schedule: CronSchedule, at: number): boolean => {
  const date = new Date(at)
  return schedule.minutes.has(date.getUTCMinutes()) && schedule.hours.has(date.getUTCHours()) && schedule.months.has(date.getUTCMonth() + 1) && dayMatches(schedule, date)
}

const MINUTE = 60_000

export const nextCronTime = (schedule: CronSchedule, after: number): number | null => {
  let at = Math.floor(after / MINUTE) * MINUTE + MINUTE
  const limit = after + 5 * 366 * 24 * 60 * MINUTE
  while (at <= limit) {
    const date = new Date(at)
    if (!schedule.months.has(date.getUTCMonth() + 1) || !dayMatches(schedule, date)) {
      at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
      continue
    }
    if (!schedule.hours.has(date.getUTCHours())) {
      at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1)
      continue
    }
    if (schedule.minutes.has(date.getUTCMinutes())) return at
    at += MINUTE
  }
  return null
}
