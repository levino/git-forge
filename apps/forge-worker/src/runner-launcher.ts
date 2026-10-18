import type { RunnerLauncher } from '@git-forge/actions'
import type { RunnerContainer } from './runner-container.ts'

export const containerLauncher = (namespace: DurableObjectNamespace<RunnerContainer>): RunnerLauncher => ({
  launch: async (launch) => {
    await namespace.get(namespace.idFromName(launch.jobId)).launch(launch.encodedJitConfig)
  },
})
