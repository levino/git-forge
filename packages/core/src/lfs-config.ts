import { fromUtf8 } from './bytes.ts'
import type { ObjectId } from './hash.ts'
import { resolvePath } from './content.ts'
import type { ObjectDatabase } from './repository.ts'

export type GitConfig = ReadonlyMap<string, string>

const unquote = (raw: string): string => {
  let out = ''
  let quoted = false
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] as string
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (char === '\\' && i + 1 < raw.length) {
      const next = raw[++i] as string
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      continue
    }
    if (!quoted && (char === '#' || char === ';')) break
    out += char
  }
  return out.trim()
}

export const parseGitConfig = (text: string): GitConfig => {
  const values = new Map<string, string>()
  let section: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const close = line.indexOf(']')
      if (close === -1) {
        section = null
        continue
      }
      const header = line.slice(1, close).trim()
      const sub = /^([A-Za-z0-9.-]+)\s+"((?:[^"\\]|\\.)*)"$/.exec(header)
      section = sub ? `${(sub[1] as string).toLowerCase()}.${(sub[2] as string).replace(/\\(.)/g, '$1')}` : header.toLowerCase()
      line = line.slice(close + 1).trim()
      if (line === '') continue
    }
    if (section === null) continue
    const match = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line)
    if (!match) continue
    values.set(`${section}.${(match[1] as string).toLowerCase()}`, match[2] === undefined ? 'true' : unquote(match[2]))
  }
  return values
}

export const normalizeLfsUrl = (raw: string): string | null => {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.username !== '' || parsed.password !== '') return null
  parsed.search = ''
  parsed.hash = ''
  return parsed.href.replace(/\/+$/, '').replace(/\/objects\/batch$/, '').replace(/\/+$/, '')
}

export const lfsUrlFromConfig = (config: GitConfig, remote = 'origin'): string | null => {
  for (const key of ['lfs.url', `remote.${remote}.lfsurl`]) {
    const value = config.get(key)
    if (value !== undefined) return normalizeLfsUrl(value)
  }
  return null
}

export type LfsConfigSource = { readonly url: string; readonly ref: string }

export const findLfsConfig = async (odb: ObjectDatabase, refs: readonly (readonly [string, ObjectId])[]): Promise<LfsConfigSource | null> => {
  for (const [ref, id] of refs) {
    const commit = await odb.peel(id)
    const entry = await resolvePath(odb, commit, ['.lfsconfig'])
    if (!entry) continue
    if (!entry.mode.startsWith('100')) return null
    const blob = await odb.read(entry.id)
    if (!blob || blob.type !== 'blob' || blob.data.length > 64 * 1024) return null
    const url = lfsUrlFromConfig(parseGitConfig(fromUtf8(blob.data)))
    return url ? { url, ref } : null
  }
  return null
}
