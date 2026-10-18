import type { ImportJob } from '@git-forge/core'
import { handle } from '@astrojs/cloudflare/handler'
import { backgroundHandlers, type Env, forgeFor } from './cloudflare.ts'
import { uiEnabled } from './config.ts'
import type { AppJob } from './app.ts'

export { RunnerContainer } from './runner-container.ts'

export default {
  async fetch(request, env, context): Promise<Response> {
    if (!uiEnabled(env)) return (await forgeFor(env)).fetch(request, (promise) => context.waitUntil(promise))
    const forge = await forgeFor(env)
    if (forge.isPagesRequest(request)) return forge.fetch(request, (promise) => context.waitUntil(promise))
    return handle(request, env as never, context)
  },
  ...backgroundHandlers,
} satisfies ExportedHandler<Env, ImportJob | AppJob>
