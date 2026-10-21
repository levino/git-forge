export const RUNNER_ENTRYPOINT = '/home/runner/run.sh'

export const RUNNER_INACTIVITY_TIMEOUT_MS = 6 * 60 * 60 * 1000

export const RUNNER_HEARTBEAT_MS = 30 * 1000

export type RunnerStopped<E> = (env: E, jobId: string) => Promise<unknown>

type RunnerMachine = {
  readonly running: boolean
  start(options: { entrypoint: string[]; enableInternet: boolean }): void
  monitor(): Promise<void>
  setInactivityTimeout(durationMs: number): Promise<void>
}

type RunnerState = {
  readonly container?: RunnerMachine | undefined
  readonly storage: {
    get<T>(key: string): Promise<T | undefined>
    put(key: string, value: unknown): Promise<void>
    deleteAll(): Promise<void>
    setAlarm(scheduledTime: number): Promise<void>
    deleteAlarm(): Promise<void>
  }
  waitUntil(promise: Promise<unknown>): void
}

export const runnerContainer = <E>(stopped: RunnerStopped<E>) =>
  class RunnerContainer {
    readonly #state: RunnerState
    readonly #env: E

    constructor(state: RunnerState, env: E) {
      this.#state = state
      this.#env = env
      const container = state.container
      if (container?.running) this.#watch(container)
    }

    #watch(container: RunnerMachine): void {
      this.#state.waitUntil(container.setInactivityTimeout(RUNNER_INACTIVITY_TIMEOUT_MS).catch(() => undefined))
      this.#state.waitUntil(container.monitor().then(() => this.#stopped(), () => this.#stopped()))
    }

    async #stopped(): Promise<void> {
      const jobId = await this.#state.storage.get<string>('jobId')
      if (jobId === undefined) return
      await stopped(this.#env, jobId)
      await this.#state.storage.deleteAll()
      await this.#state.storage.deleteAlarm()
    }

    async alarm(): Promise<void> {
      if (!this.#state.container?.running) return this.#stopped()
      await this.#state.storage.setAlarm(Date.now() + RUNNER_HEARTBEAT_MS)
    }

    async fetch(request: Request): Promise<Response> {
      const container = this.#state.container
      if (!container) return new Response('this Durable Object has no container\n', { status: 500 })
      if (request.method !== 'POST') return new Response('method not allowed\n', { status: 405 })
      if (container.running) return new Response('runner already started\n', { status: 409 })
      const jobId = new URL(request.url).searchParams.get('job')
      const encodedJitConfig = await request.text()
      container.start({ entrypoint: [RUNNER_ENTRYPOINT, '--jitconfig', encodedJitConfig], enableInternet: true })
      if (jobId) {
        await this.#state.storage.put('jobId', jobId)
        await this.#state.storage.setAlarm(Date.now() + RUNNER_HEARTBEAT_MS)
      }
      this.#watch(container)
      return new Response(null, { status: 202 })
    }
  }
