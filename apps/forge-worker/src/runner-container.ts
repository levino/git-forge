import { Container } from '@cloudflare/containers'

export class RunnerContainer extends Container {
  override sleepAfter = '2h'
  override enableInternet = true

  async launch(encodedJitConfig: string): Promise<void> {
    await this.start({ envVars: { ACTIONS_RUNNER_JITCONFIG: encodedJitConfig } })
  }
}
