import { isValidName, type RepositoryName } from '@git-forge/core'

export type PagesHosts = {
  readonly scheme: 'http' | 'https'
  readonly ownerSuffix: string | null
  readonly domains: ReadonlyMap<string, RepositoryName>
}

export type PagesHostMatch =
  | { readonly kind: 'owner'; readonly owner: string; readonly host: string }
  | { readonly kind: 'domain'; readonly repo: RepositoryName; readonly host: string }

export class PagesConfigError extends Error {}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/

export const parsePagesHosts = (pattern: string | undefined, domains: string | undefined): PagesHosts | null => {
  const hostPattern = pattern?.trim() ?? ''
  const domainText = domains?.trim() ?? ''
  if (hostPattern === '' && domainText === '') return null
  let scheme: 'http' | 'https' = 'https'
  let ownerSuffix: string | null = null
  if (hostPattern !== '') {
    const match = /^(?:(https?):\/\/)?\{owner\}\.([a-z0-9.-]+(?::\d{1,5})?)\/?$/i.exec(hostPattern)
    if (!match) throw new PagesConfigError('PAGES_HOST must look like {owner}.pages.example.org (optionally with http:// or https:// and a port)')
    scheme = (match[1]?.toLowerCase() as 'http' | 'https' | undefined) ?? 'https'
    ownerSuffix = match[2]!.toLowerCase()
  }
  const map = new Map<string, RepositoryName>()
  if (domainText !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(domainText)
    } catch {
      throw new PagesConfigError('PAGES_DOMAINS must be a JSON object like {"docs.example.org": "owner/repo"}')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new PagesConfigError('PAGES_DOMAINS must be a JSON object like {"docs.example.org": "owner/repo"}')
    for (const [host, target] of Object.entries(parsed)) {
      const [owner, name, ...rest] = typeof target === 'string' ? target.split('/') : []
      if (!HOST.test(host.toLowerCase()) || !owner || !name || rest.length > 0 || !isValidName(owner) || !isValidName(name)) {
        throw new PagesConfigError(`PAGES_DOMAINS: invalid mapping ${host} -> ${String(target)}`)
      }
      if (ownerSuffix && host.toLowerCase().endsWith(`.${ownerSuffix}`)) throw new PagesConfigError(`PAGES_DOMAINS: ${host} lies under the PAGES_HOST pattern`)
      map.set(host.toLowerCase(), { owner, name })
    }
  }
  return { scheme, ownerSuffix, domains: map }
}

export const matchPagesHost = (hosts: PagesHosts | null, host: string): PagesHostMatch | null => {
  if (!hosts) return null
  const normalized = host.toLowerCase()
  const repo = hosts.domains.get(normalized)
  if (repo) return { kind: 'domain', repo, host: normalized }
  if (!hosts.ownerSuffix || !normalized.endsWith(`.${hosts.ownerSuffix}`)) return null
  const owner = normalized.slice(0, -hosts.ownerSuffix.length - 1)
  return LABEL.test(owner) ? { kind: 'owner', owner, host: normalized } : null
}

export const ownerHost = (hosts: PagesHosts, owner: string): string | null => {
  const label = owner.toLowerCase()
  return hosts.ownerSuffix && LABEL.test(label) ? `${label}.${hosts.ownerSuffix}` : null
}

export const isUserSiteRepository = (hosts: PagesHosts, repo: RepositoryName): boolean => {
  const host = ownerHost(hosts, repo.owner)
  return host !== null && repo.name.toLowerCase() === host.replace(/:\d+$/, '')
}

export const customDomain = (hosts: PagesHosts, repo: RepositoryName): string | null => {
  for (const [host, target] of hosts.domains) {
    if (target.owner.toLowerCase() === repo.owner.toLowerCase() && target.name.toLowerCase() === repo.name.toLowerCase()) return host
  }
  return null
}

export const pagesUrl = (hosts: PagesHosts | null, repo: RepositoryName): string | null => {
  if (!hosts) return null
  const domain = customDomain(hosts, repo)
  if (domain) return `${hosts.scheme}://${domain}/`
  const host = ownerHost(hosts, repo.owner)
  if (!host) return null
  return isUserSiteRepository(hosts, repo) ? `${hosts.scheme}://${host}/` : `${hosts.scheme}://${host}/${repo.name}/`
}

export const isPagesUrl = (hosts: PagesHosts | null, url: URL): boolean =>
  hosts !== null && url.protocol === `${hosts.scheme}:` && matchPagesHost(hosts, url.host) !== null && url.username === '' && url.password === ''
