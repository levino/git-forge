const UNITS: Readonly<Record<string, number>> = {
  '': 1,
  b: 1,
  k: 1e3,
  kb: 1e3,
  m: 1e6,
  mb: 1e6,
  g: 1e9,
  gb: 1e9,
  ki: 1024,
  kib: 1024,
  mi: 1024 ** 2,
  mib: 1024 ** 2,
  gi: 1024 ** 3,
  gib: 1024 ** 3,
}

export const parseSize = (text: string): number => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/.exec(text)
  const factor = match ? UNITS[(match[2] ?? '').toLowerCase()] : undefined
  if (!match || factor === undefined) throw new Error(`invalid size: ${text}`)
  const bytes = Math.floor(Number(match[1]) * factor)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error(`invalid size: ${text}`)
  return bytes
}

export const formatSize = (bytes: number): string => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} kB`
  return `${bytes} B`
}
