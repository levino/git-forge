import type { LoginPage, LoginPageRenderer } from '@git-forge/accounts'

export const LOGIN_PAGE_HEADER = 'X-Forge-Login-Page'

export const LOGIN_PAGE_ROUTE = '/-/login'

const captured = new WeakMap<Request, LoginPage>()

export const captureLoginPage: LoginPageRenderer = (page, request) => {
  captured.set(request, page)
  return new Response(null, { status: 200, headers: { [LOGIN_PAGE_HEADER]: '1' } })
}

export const takeLoginPage = (request: Request, response: Response): LoginPage | null => {
  if (!response.headers.has(LOGIN_PAGE_HEADER)) return null
  const page = captured.get(request) ?? null
  captured.delete(request)
  return page
}

export const loginPageTitle = (page: LoginPage): string => {
  switch (page.kind) {
    case 'login':
      return page.user ? 'Signed in' : 'Sign in'
    case 'invite':
      return 'Accept invite'
    case 'device':
      return 'Connect a device'
    case 'device-result':
      return page.approved ? 'Device connected' : 'Request denied'
    case 'break-glass':
      return 'Break-glass login'
    case 'error':
      return 'Sign-in failed'
  }
}

export const LOGIN_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
