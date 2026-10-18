import type { RunnerLauncher } from '@git-forge/actions'

export const containerLauncher = (namespace: DurableObjectNamespace): RunnerLauncher => ({
  launch: async (launch) => {
    const response = await namespace.get(namespace.idFromName(launch.jobId)).fetch('https://runner.internal/launch', { method: 'POST', body: launch.encodedJitConfig })
    if (response.status !== 202) throw new Error(`runner container did not start: ${response.status} ${await response.text()}`)
  },
})
