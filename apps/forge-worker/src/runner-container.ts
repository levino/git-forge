export const RUNNER_ENTRYPOINT = '/home/runner/run.sh'

export const RUNNER_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000

export class RunnerContainer implements DurableObject {
  readonly #state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.#state = state
    const container = state.container
    if (container?.running) this.#watch(container)
  }

  #watch(container: Container): void {
    this.#state.waitUntil(container.setInactivityTimeout(RUNNER_INACTIVITY_TIMEOUT_MS).catch(() => undefined))
    this.#state.waitUntil(container.monitor().catch(() => undefined))
  }

  async fetch(request: Request): Promise<Response> {
    const container = this.#state.container
    if (!container) return new Response('this Durable Object has no container\n', { status: 500 })
    if (request.method !== 'POST') return new Response('method not allowed\n', { status: 405 })
    if (container.running) return new Response('runner already started\n', { status: 409 })
    const encodedJitConfig = await request.text()
    container.start({ entrypoint: [RUNNER_ENTRYPOINT, '--jitconfig', encodedJitConfig], enableInternet: true })
    this.#watch(container)
    return new Response(null, { status: 202 })
  }
}

export class DockerRunnerContainer extends RunnerContainer {}
