import { Container, getContainer } from '@cloudflare/containers'
import type { RunnerLauncher } from '@git-forge/actions'

export class RunnerContainer extends Container {
  override sleepAfter = '2h'
  override enableInternet = true

  async launch(encodedJitConfig: string): Promise<void> {
    await this.start({ envVars: { ACTIONS_RUNNER_JITCONFIG: encodedJitConfig } })
  }
}

export const containerLauncher = (namespace: DurableObjectNamespace<RunnerContainer>): RunnerLauncher => ({
  launch: async (launch) => {
    await getContainer(namespace, launch.jobId).launch(launch.encodedJitConfig)
  },
})
