import { toHex, utf8 } from '@git-forge/accounts'
import type { JobRow, RunRow } from './store.ts'

export type WorkflowJobAction = 'queued' | 'in_progress' | 'completed'

export const signWebhookPayload = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `sha256=${toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(body))))}`
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString())

export const workflowJobPayload = (action: WorkflowJobAction, job: JobRow, run: RunRow, serverUrl: string, runnerName: string | null) => {
  const repository = `${run.owner}/${run.repo}`
  return {
    action,
    workflow_job: {
      id: job.request_id,
      run_id: run.id,
      run_attempt: job.attempt,
      head_sha: run.sha,
      head_branch: run.ref.replace(/^refs\/(heads|tags)\//, ''),
      workflow_name: run.workflow_name,
      name: job.display_name,
      status: action,
      conclusion: action === 'completed' ? job.conclusion : null,
      created_at: iso(job.queued_at),
      started_at: iso(job.started_at),
      completed_at: iso(job.completed_at),
      labels: JSON.parse(job.labels) as string[],
      runner_id: job.runner_id,
      runner_name: runnerName,
      runner_group_id: job.runner_id === null ? null : 1,
      runner_group_name: job.runner_id === null ? null : 'Default',
      url: `${serverUrl}/api/v3/repos/${repository}/actions/jobs/${job.request_id}`,
      html_url: `${serverUrl}/${repository}/actions/runs/${run.id}/job/${job.request_id}`,
      run_url: `${serverUrl}/api/v3/repos/${repository}/actions/runs/${run.id}`,
    },
    repository: { full_name: repository, name: run.repo, owner: { login: run.owner }, html_url: `${serverUrl}/${repository}` },
  }
}

export type WebhookDelivery = {
  readonly url: string
  readonly secret: string
}

export const deliverWebhook = async (delivery: WebhookDelivery, event: string, payload: unknown, fetcher: typeof fetch = fetch): Promise<Response> => {
  const body = JSON.stringify(payload)
  return fetcher(delivery.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GitHub-Hookshot/git-forge',
      'X-GitHub-Event': event,
      'X-GitHub-Delivery': crypto.randomUUID(),
      'X-Hub-Signature-256': await signWebhookPayload(delivery.secret, body),
    },
    body,
  })
}
