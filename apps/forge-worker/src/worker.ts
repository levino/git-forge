import type { ImportJob } from '@git-forge/core'
import { handle } from '@astrojs/cloudflare/handler'
import { backgroundHandlers, type Env, forgeFor } from './cloudflare.ts'
import { uiEnabled } from './config.ts'
import type { AppJob } from './app.ts'

export { DockerRunnerContainer, RunnerContainer } from './runner-container.ts'

const timed = (response: Response, started: number): Response => {
  try {
    response.headers.append('Server-Timing', `app;dur=${Date.now() - started}`)
    return response
  } catch {
    return response
  }
}

export default {
  async fetch(request, env, context): Promise<Response> {
    const started = Date.now()
    const forge = await forgeFor(env)
    if (!uiEnabled(env) || forge.isPagesRequest(request)) return timed(await forge.fetch(request, (promise) => context.waitUntil(promise)), started)
    return timed(await handle(request, env as never, context), started)
  },
  ...backgroundHandlers,
} satisfies ExportedHandler<Env, ImportJob | AppJob>
