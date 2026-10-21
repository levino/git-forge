import { type Principal, sha256Hex } from '@git-forge/accounts'
import { isAnonymousRequest } from '../cache-control.ts'
import { isValidName, readRefs } from '@git-forge/core'
import type { ForgeServices } from '../app.ts'
import { accessFor } from './repository.ts'

export type PageCache = {
  readonly match: (key: string) => Promise<Response | null>
  readonly put: (key: string, response: Response) => Promise<void>
}

const SECTIONS = new Set(['tree', 'blob', 'blame', 'commits', 'commit', 'branches', 'tags', 'forks', 'releases', 'issues', 'pulls', 'pull', 'discussions'])

const FORMS = new Set(['new', 'edit'])

export const cacheablePath = (pathname: string): { readonly owner: string; readonly name: string } | null => {
  const [empty, owner, name, section, next] = pathname.split('/')
  if (empty !== '' || !owner || !name || !isValidName(owner) || !isValidName(name)) return null
  if (section === undefined) return { owner, name }
  return SECTIONS.has(section) && !(next !== undefined && FORMS.has(next)) ? { owner, name } : null
}

const isStorable = (response: Response): boolean =>
  response.status === 200 && (response.headers.get('Content-Type') ?? '').startsWith('text/html') && !response.headers.has('Set-Cookie') && !/\b(private|no-store)\b/.test(response.headers.get('Cache-Control') ?? '')

const served = (response: Response, state: 'hit' | 'miss'): Response => {
  const headers = new Headers(response.headers)
  headers.set('X-Forge-Cache', state)
  headers.set('Vary', 'Cookie, Authorization')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export const PAGE_CACHE_SECONDS = 300

export const cachedPage = async (
  forge: ForgeServices,
  request: Request,
  principal: Principal,
  render: () => Promise<Response>,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> => {
  const cache = forge.pageCache
  const repo = request.method === 'GET' ? cacheablePath(new URL(request.url).pathname) : null
  if (!cache || !repo || principal.kind !== 'anonymous' || !isAnonymousRequest(request)) return render()
  const [check, refs, changes] = await Promise.all([accessFor(forge, request, principal, repo), readRefs(forge.storage, repo), forge.repositoryChanges(repo)])
  if (check.decision !== 'allow' || check.view || !check.repository || check.repository.visibility !== 'public') return render()
  const key = await sha256Hex(JSON.stringify([forge.version, request.url, check.repository, refs?.etag ?? null, changes]))
  const hit = await cache.match(key).catch(() => null)
  if (hit) return served(hit, 'hit')
  const response = await render()
  if (!isStorable(response)) return response
  const stored = cache.put(key, response.clone()).catch(() => {})
  if (waitUntil) waitUntil(stored)
  else await stored
  return served(response, 'miss')
}
