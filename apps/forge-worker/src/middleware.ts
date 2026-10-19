import { env } from 'cloudflare:workers'
import { defineMiddleware } from 'astro/middleware'
import { type Env, forgeFor } from './cloudflare.ts'
import { isCrossSiteWrite, isForgePath, isLoginPath } from './routing.ts'
import { LOGIN_PAGE_ROUTE, takeLoginPage } from './ui/login-pages.ts'

export const onRequest = defineMiddleware(async (context, next) => {
  const forge = await forgeFor(env as unknown as Env)
  const signIn = async () => {
    context.locals.forge = forge.services
    const session = await forge.services.session(context.request)
    context.locals.session = session
    if (session) context.locals.instanceAdmin = forge.services.instance.isAdministrator(session.principal).catch(() => false)
    context.locals.principal = session?.principal ?? (await forge.services.authenticate(context.request)) ?? { kind: 'anonymous' }
  }
  if (isForgePath(context.url.pathname)) {
    const execution = context.locals.cfContext
    const request: Request = isLoginPath(context.url.pathname) ? (context.request.clone() as Request) : context.request
    const response = await forge.fetch(request, execution ? (promise) => execution.waitUntil(promise) : undefined)
    const page = takeLoginPage(request, response)
    if (!page) return response
    await signIn()
    context.locals.loginPage = page
    return next(LOGIN_PAGE_ROUTE)
  }
  if (isCrossSiteWrite(context.request)) return new Response('cross-site request refused\n', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  await signIn()
  const response = await next()
  const execution = context.locals.cfContext
  await forge.services.observe(execution ? (promise) => execution.waitUntil(promise) : undefined)
  if (response.status !== 404) return response
  const location = await forge.services.redirect(context.request, context.locals.principal)
  return location ? new Response(null, { status: context.request.method === 'GET' ? 301 : 307, headers: { Location: location } }) : response
})
