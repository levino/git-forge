export const CODEOWNERS_LOCATIONS: readonly string[] = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']

export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024

export type CodeOwner =
  | { readonly kind: 'user'; readonly login: string }
  | { readonly kind: 'team'; readonly organization: string; readonly slug: string }
  | { readonly kind: 'email'; readonly email: string }

export type CodeOwnersRule = {
  readonly line: number
  readonly pattern: string
  readonly owners: readonly CodeOwner[]
  readonly matcher: (path: string) => boolean
}

export type CodeOwnersError = { readonly line: number; readonly message: string }

export type CodeOwners = {
  readonly path: string
  readonly rules: readonly CodeOwnersRule[]
  readonly errors: readonly CodeOwnersError[]
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const TEAM = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]*$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const parseOwner = (token: string): CodeOwner | null => {
  if (token.startsWith('@')) {
    const name = token.slice(1)
    if (TEAM.test(name)) {
      const slash = name.indexOf('/')
      return { kind: 'team', organization: name.slice(0, slash), slug: name.slice(slash + 1) }
    }
    return LOGIN.test(name) ? { kind: 'user', login: name } : null
  }
  return EMAIL.test(token) ? { kind: 'email', email: token } : null
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

const segmentSource = (pattern: string): string => {
  let source = ''
  let i = 0
  while (i < pattern.length) {
    const char = pattern[i]!
    const segmentStart = i === 0 || pattern[i - 1] === '/'
    if (char === '*' && pattern[i + 1] === '*' && segmentStart && (pattern[i + 2] === '/' || i + 2 === pattern.length)) {
      if (pattern[i + 2] === '/') {
        source += '(?:[^/]*/)*'
        i += 3
      } else {
        source += '.*'
        i += 2
      }
    } else if (char === '*') {
      source += '[^/]*'
      while (pattern[i] === '*') i++
    } else if (char === '?') {
      source += '[^/]'
      i++
    } else if (char === '\\' && i + 1 < pattern.length) {
      source += escapeRegex(pattern[i + 1]!)
      i += 2
    } else {
      source += escapeRegex(char)
      i++
    }
  }
  return source
}

export const compileCodeOwnersPattern = (pattern: string): ((path: string) => boolean) => {
  const directoryOnly = pattern.endsWith('/')
  const trimmed = directoryOnly ? pattern.replace(/\/+$/, '') : pattern
  const anchored = trimmed.includes('/')
  const body = trimmed.replace(/^\/+/, '')
  const regex = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${segmentSource(body)}$`)
  const prefixes = !/(^|\/)\*$/.test(body) || body === '*'
  return (path: string) => {
    const segments = path.split('/')
    if (!directoryOnly && regex.test(path)) return true
    if (!prefixes) return false
    for (let end = segments.length - 1; end >= 1; end--) if (regex.test(segments.slice(0, end).join('/'))) return true
    return false
  }
}

const tokens = (line: string): string[] => {
  const out: string[] = []
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '\\' && i + 1 < line.length) {
      current += char + line[i + 1]
      i++
    } else if (char === ' ' || char === '\t') {
      if (current !== '') out.push(current)
      current = ''
    } else if (char === '#' && current === '') {
      break
    } else {
      current += char
    }
  }
  if (current !== '') out.push(current)
  return out
}

export const parseCodeOwners = (text: string, path = 'CODEOWNERS'): CodeOwners => {
  const rules: CodeOwnersRule[] = []
  const errors: CodeOwnersError[] = []
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const parts = tokens(raw)
    if (parts.length === 0) return
    const [pattern, ...ownerTokens] = parts as [string, ...string[]]
    if (pattern.startsWith('!')) return errors.push({ line, message: `negation is not supported: ${pattern}` })
    if (/(^|[^\\])\[/.test(pattern)) return errors.push({ line, message: `character ranges are not supported: ${pattern}` })
    const owners: CodeOwner[] = []
    for (const token of ownerTokens) {
      const owner = parseOwner(token)
      if (owner) owners.push(owner)
      else errors.push({ line, message: `unknown owner ${token}` })
    }
    rules.push({ line, pattern, owners, matcher: compileCodeOwnersPattern(pattern) })
  })
  return { path, rules, errors }
}

export const matchCodeOwners = (codeowners: CodeOwners, path: string): CodeOwnersRule | null => {
  for (let i = codeowners.rules.length - 1; i >= 0; i--) if (codeowners.rules[i]!.matcher(path)) return codeowners.rules[i]!
  return null
}

export const ownersOf = (codeowners: CodeOwners, path: string): readonly CodeOwner[] => matchCodeOwners(codeowners, path)?.owners ?? []

export const ownerLabel = (owner: CodeOwner): string =>
  owner.kind === 'user' ? `@${owner.login}` : owner.kind === 'team' ? `@${owner.organization}/${owner.slug}` : owner.email
