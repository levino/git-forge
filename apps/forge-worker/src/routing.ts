import { matchContentRoute, matchGitRoute } from '@git-forge/core'

const FORGE_PREFIXES = ['/api/', '/_services/', '/_pages/', '/.well-known/', '/login/', '/twirp/', '/scim/']

const FORGE_PATHS = new Set(['/api', '/login', '/logout'])

const GIT_SUBPATH = /^\/(HEAD|info\/refs|git-upload-pack|git-receive-pack|objects\/.+|info\/lfs(\/.*)?|forge\/uploads(\/.*)?|releases\/download\/.+)$/

export const isForgePath = (pathname: string): boolean => {
  if (FORGE_PATHS.has(pathname) || FORGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
  if (matchContentRoute(pathname)) return true
  const git = matchGitRoute(pathname)
  if (!git) return false
  const [, , repo] = pathname.split('/')
  return repo!.endsWith('.git') || GIT_SUBPATH.test(git.path)
}

const FORM_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']

export const isCrossSiteWrite = (request: Request): boolean => {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false
  const origin = request.headers.get('Origin')
  if (origin !== null) return origin !== new URL(request.url).origin
  const site = request.headers.get('Sec-Fetch-Site')
  if (site !== null) return site !== 'same-origin'
  const type = (request.headers.get('Content-Type') ?? '').split(';', 1)[0]!.trim().toLowerCase()
  return FORM_TYPES.includes(type)
}

export const isLoginPath = (pathname: string): boolean => pathname === '/login' || pathname === '/logout' || pathname.startsWith('/login/')
