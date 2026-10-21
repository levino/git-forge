import { describe, expect, it } from 'vitest'
import { RUNNER_HEARTBEAT_MS, runnerContainer } from '../../src/runner-container.ts'

const fakeState = () => {
  const data = new Map<string, unknown>()
  const pending: Promise<unknown>[] = []
  let exit = (): void => undefined
  const container = {
    running: false,
    start: () => {
      container.running = true
    },
    monitor: () =>
      new Promise<void>((resolve) => {
        exit = resolve
      }),
    setInactivityTimeout: async () => undefined,
  }
  const storage = {
    alarm: null as number | null,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void data.set(key, value),
    deleteAll: async () => data.clear(),
    setAlarm: async (at: number) => void (storage.alarm = at),
    deleteAlarm: async () => void (storage.alarm = null),
  }
  const state = { container, storage, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) }
  const stop = async () => {
    container.running = false
    exit()
    await Promise.all(pending)
  }
  return { state, container, storage, stop }
}

const launch = (object: { fetch(request: Request): Promise<Response> }) => object.fetch(new Request('https://runner.internal/launch?job=job-1', { method: 'POST', body: 'config' }))

describe('runner container', () => {
  it('reports the job when the container exits', async () => {
    const stopped: string[] = []
    const Runner = runnerContainer<null>(async (_env, jobId) => stopped.push(jobId))
    const fake = fakeState()
    const object = new Runner(fake.state, null)
    expect((await launch(object)).status).toBe(202)
    expect(fake.storage.alarm).toBeGreaterThan(Date.now() + RUNNER_HEARTBEAT_MS - 1000)
    expect((await launch(object)).status).toBe(409)
    await fake.stop()
    expect(stopped).toEqual(['job-1'])
    expect(fake.storage.alarm).toBeNull()
  })

  it('reports the job from the heartbeat alarm when the container is gone after a restart', async () => {
    const stopped: string[] = []
    const Runner = runnerContainer<null>(async (_env, jobId) => stopped.push(jobId))
    const fake = fakeState()
    await launch(new Runner(fake.state, null))
    const restarted = new Runner(fake.state, null)
    await restarted.alarm()
    expect(stopped).toEqual([])
    fake.container.running = false
    await restarted.alarm()
    expect(stopped).toEqual(['job-1'])
    expect(fake.storage.alarm).toBeNull()
  })
})
