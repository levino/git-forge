import type { ImportJob } from '@git-forge/core'
import { handle } from '@astrojs/cloudflare/handler'
import { sessionStart, withBookmark } from '@git-forge/cloudflare'
import { backgroundHandlers, type Env, forgeFor, sessionsFor } from './cloudflare.ts'
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
    const [forge, sessions] = await Promise.all([forgeFor(env), sessionsFor(env)])
    const outcome = await sessions.run(sessionStart(request), async () => {
      if (!uiEnabled(env) || forge.isPagesRequest(request)) return forge.fetch(request, (promise) => context.waitUntil(promise))
      return handle(request, env as never, context)
    })
    return timed(withBookmark(request, outcome.value, outcome), started)
  },
  ...backgroundHandlers,
} satisfies ExportedHandler<Env, ImportJob | AppJob>
