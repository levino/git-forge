import { handle } from '@astrojs/cloudflare/handler'
import type { Forge } from './app.ts'
import { type ForgeVars, uiEnabled } from './config.ts'
import { cacheControlled } from './cache-control.ts'

export type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; readonly props?: unknown }

export type Host<E extends ForgeVars> = {
  readonly forge: (env: E) => Promise<Forge>
  readonly around?: (request: Request, env: E, run: () => Promise<Response>) => Promise<Response>
  readonly sharedCache?: boolean
}

let current: (() => Promise<Forge>) | undefined

export const hostForge = (): Promise<Forge> => {
  if (!current) throw new Error('no host is installed')
  return current()
}

export const createWorker = <E extends ForgeVars>(host: Host<E>) => ({
  async fetch(request: Request, env: E, context: ExecutionContextLike): Promise<Response> {
    current = () => host.forge(env)
    const forge = await host.forge(env)
    const run = () =>
      forge.scope(async () => {
        if (!uiEnabled(env) || forge.isPagesRequest(request)) return forge.fetch(request, (promise) => context.waitUntil(promise))
        return handle(request, env as never, context as never)
      })
    return cacheControlled(request, await (host.around ? host.around(request, env, run) : run()), host.sharedCache)
  },
})
