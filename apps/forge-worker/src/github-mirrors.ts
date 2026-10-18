import {
  type FetchFunction,
  GITHUB_SIGNATURE_HEADER,
  type GitHubHook,
  githubRepositoryOf,
  readAll,
  readMirrorConfig,
  registerGitHubWebhook,
  type RepositoryName,
  SizeLimitError,
  type Storage,
  toHex,
  verifyGitHubSignature,
} from '@git-forge/core'
import type { MirrorFederation } from './mirror-federation.ts'
import type { MirrorSecrets } from './mirror-secrets.ts'

export const MAX_WEBHOOK_BYTES = 26 * 1024 * 1024

export const webhookUrl = (base: string, repo: RepositoryName, remote: string): string =>
  `${base.replace(/\/+$/, '')}/api/repos/${repo.owner}/${repo.name}/mirrors/${remote}/webhook`

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

export type WebhookSetup = {
  readonly url: string
  readonly secret: string
  readonly contentType: 'json'
  readonly events: readonly ['push']
  readonly hook?: GitHubHook
}

export const setUpGitHubWebhook = async (
  context: { readonly storage: Storage; readonly secrets: MirrorSecrets; readonly fetch?: FetchFunction },
  repo: RepositoryName,
  remote: string,
  base: string,
  githubToken?: string,
): Promise<WebhookSetup> => {
  const config = await readMirrorConfig(context.storage, repo, remote)
  if (!config) throw new Error('mirror not configured')
  const secret = toHex(crypto.getRandomValues(new Uint8Array(32)))
  await context.secrets.put(repo, remote, 'webhook', secret)
  const url = webhookUrl(base, repo, remote)
  const repository = githubRepositoryOf(config.url)
  if (!githubToken || !repository) return { url, secret, contentType: 'json', events: ['push'] }
  const hook = await registerGitHubWebhook({ repository, url, secret, token: githubToken, ...(context.fetch ? { fetch: context.fetch } : {}) })
  return { url, secret, contentType: 'json', events: ['push'], hook }
}

export const receiveGitHubWebhook = async (
  context: { readonly storage: Storage; readonly secrets: MirrorSecrets; readonly federation: MirrorFederation | null },
  request: Request,
  repo: RepositoryName,
  remote: string,
): Promise<Response> => {
  const { storage, secrets, federation } = context
  const secret = await secrets.get(repo, remote, 'webhook')
  if (!secret) return json(404, { error: 'no webhook configured for this mirror' })
  let body: Uint8Array
  try {
    body = request.body ? await readAll(request.body, MAX_WEBHOOK_BYTES) : new Uint8Array(0)
  } catch (error) {
    if (error instanceof SizeLimitError) return json(413, { error: 'payload too large' })
    throw error
  }
  if (!(await verifyGitHubSignature(secret, body, request.headers.get(GITHUB_SIGNATURE_HEADER)))) return json(401, { error: 'invalid signature' })
  const event = request.headers.get('X-GitHub-Event')
  if (event === 'ping') return json(200, { status: 'pong' })
  if (event !== 'push') return json(200, { status: 'ignored', event })
  const config = await readMirrorConfig(storage, repo, remote)
  if (!config) return json(404, { error: 'mirror not configured' })
  if (config.detachedAt || config.mode !== 'auto') return json(200, { status: 'ignored', reason: config.detachedAt ? 'detached' : 'manual' })
  if (!federation) return json(503, { error: 'webhooks need PUBLIC_URL, INSTANCE_KEY and a job queue' })
  await federation.jobs.enqueue({ kind: 'mirror-sync', repository: `${repo.owner}/${repo.name}`, remote, reason: 'webhook' })
  return json(202, { status: 'queued' })
}
