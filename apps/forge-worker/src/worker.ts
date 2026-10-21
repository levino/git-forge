import type { ImportJob } from '@git-forge/core'
import { sessionStart, withBookmark } from '@git-forge/cloudflare'
import { backgroundHandlers, type Env, forgeFor, sessionsFor } from './cloudflare.ts'
import type { AppJob } from './app.ts'
import { createWorker } from './host.ts'

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
  ...createWorker<Env>({
    forge: forgeFor,
    around: async (request, env, run) => {
      const started = Date.now()
      const outcome = await (await sessionsFor(env)).run(sessionStart(request), run)
      return timed(withBookmark(request, outcome.value, outcome), started)
    },
  }),
  ...backgroundHandlers,
} satisfies ExportedHandler<Env, ImportJob | AppJob>
