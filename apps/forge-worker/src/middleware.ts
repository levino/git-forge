import { defineMiddleware } from 'astro/middleware'
import { hostForge } from './host.ts'
import { isCrossSiteWrite, isForgePath, isLoginPath } from './routing.ts'
import { cachedPage } from './ui/page-cache.ts'
import { signIn } from './ui/sign-in.ts'
import { LOGIN_PAGE_ROUTE, takeLoginPage } from './ui/login-pages.ts'

export const onRequest = defineMiddleware(async (context, next) => {
  const forge = await hostForge()
  const setLocals = async () => {
    context.locals.forge = forge.services
    const signed = await signIn(forge.services, context.request)
    context.locals.session = signed.session
    context.locals.principal = signed.principal
    if (signed.instanceAdmin) context.locals.instanceAdmin = signed.instanceAdmin
  }
  if (isForgePath(context.url.pathname)) {
    const execution = context.locals.cfContext
    const request: Request = isLoginPath(context.url.pathname) ? (context.request.clone() as Request) : context.request
    const response = await forge.fetch(request, execution ? (promise) => execution.waitUntil(promise) : undefined)
    const page = takeLoginPage(request, response)
    if (!page) return response
    await setLocals()
    context.locals.loginPage = page
    return next(LOGIN_PAGE_ROUTE)
  }
  if (isCrossSiteWrite(context.request)) return new Response('cross-site request refused\n', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  await setLocals()
  const execution = context.locals.cfContext
  const response = await cachedPage(forge.services, context.request, context.locals.principal, () => next(), execution ? (promise) => execution.waitUntil(promise) : undefined)
  await forge.services.observe(execution ? (promise) => execution.waitUntil(promise) : undefined)
  if (response.status !== 404) return response
  const location = await forge.services.redirect(context.request, context.locals.principal)
  return location ? new Response(null, { status: context.request.method === 'GET' ? 301 : 307, headers: { Location: location } }) : response
})
