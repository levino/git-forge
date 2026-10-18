export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

const RELATIVE: readonly [number, Intl.RelativeTimeFormatUnit][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [30, 'day'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year'],
]

export const relativeTime = (seconds: number, now: number): string => {
  let value = seconds - now
  for (const [size, unit] of RELATIVE) {
    if (Math.abs(value) < size) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(value), unit)
    value /= size
  }
  return ''
}

export const isoTime = (seconds: number): string => new Date(seconds * 1000).toISOString()

export const shortId = (id: string): string => id.slice(0, 7)

export const encodePath = (segments: readonly string[]): string => segments.map(encodeURIComponent).join('/')

export const plural = (count: number, singular: string, pluralForm = `${singular}s`): string => `${count} ${count === 1 ? singular : pluralForm}`
