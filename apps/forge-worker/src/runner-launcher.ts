import type { RunnerLauncher } from '@git-forge/actions'

export const containerLauncher = (namespace: DurableObjectNamespace, docker: DurableObjectNamespace | undefined, labels: readonly string[] | undefined): RunnerLauncher => ({
  ...(labels ? { labels } : {}),
  launch: async (launch) => {
    const target = (launch.docker && docker) || namespace
    const response = await target.get(target.idFromName(launch.jobId)).fetch('https://runner.internal/launch', { method: 'POST', body: launch.encodedJitConfig })
    if (response.status !== 202) throw new Error(`runner container did not start: ${response.status} ${await response.text()}`)
  },
})
