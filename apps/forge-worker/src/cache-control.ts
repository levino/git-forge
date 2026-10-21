import { cookieNames } from '@git-forge/accounts'

const SESSION_COOKIES = [cookieNames(true).session, cookieNames(false).session]

const hasSession = (request: Request): boolean =>
  (request.headers.get('Cookie') ?? '')
    .split(';')
    .map((part) => part.trim().split('=', 1)[0])
    .some((name) => SESSION_COOKIES.includes(name!))

export const isAnonymousRequest = (request: Request): boolean => !request.headers.has('Authorization') && !hasSession(request)

const SHARED = /\b(public|s-maxage=\d+)\b\s*,?\s*/gi

const SHARED_DIRECTIVE = /\b(public|s-maxage=\d+)\b/i

export const cacheControlled = (request: Request, response: Response, sharedCache = false): Response => {
  const value = response.headers.get('Cache-Control')
  const personal = hasSession(request) || response.headers.has('Set-Cookie') || (sharedCache && request.headers.has('Authorization'))
  if (response.status === 101 || (value !== null && !(personal && SHARED_DIRECTIVE.test(value)))) return response
  const headers = new Headers(response.headers)
  const kept = value?.replace(SHARED, '').replace(/,\s*$/, '').trim()
  headers.set('Cache-Control', kept ? `private, ${kept}` : 'private, no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
