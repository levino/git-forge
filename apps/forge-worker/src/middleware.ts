import { env } from 'cloudflare:workers'
import { defineMiddleware } from 'astro/middleware'
import { type Env, forgeFor } from './cloudflare.ts'
import { isCrossSiteWrite, isForgePath } from './routing.ts'

export const onRequest = defineMiddleware(async (context, next) => {
  const forge = await forgeFor(env as unknown as Env)
  if (isForgePath(context.url.pathname)) return forge.fetch(context.request)
  if (isCrossSiteWrite(context.request)) return new Response('cross-site request refused\n', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  context.locals.forge = forge.services
  context.locals.principal = (await forge.services.authenticate(context.request)) ?? { kind: 'anonymous' }
  return next()
})
