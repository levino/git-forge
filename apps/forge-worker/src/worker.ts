import type { ImportJob } from '@git-forge/core'
import { handle } from '@astrojs/cloudflare/handler'
import { backgroundHandlers, type Env, forgeFor } from './cloudflare.ts'
import { uiEnabled } from './config.ts'
import type { ForgeJob } from './mirror-federation.ts'

export { RunnerContainer } from './runner-container.ts'

export default {
  async fetch(request, env, context): Promise<Response> {
    if (uiEnabled(env)) return handle(request, env as never, context)
    return (await forgeFor(env)).fetch(request)
  },
  ...backgroundHandlers,
} satisfies ExportedHandler<Env, ImportJob | ForgeJob>
