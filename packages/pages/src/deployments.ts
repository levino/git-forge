import type { RepositorySubject } from '@git-forge/accounts'
import { type DigestFactory, maybeGunzip, ObjectDatabase, type RepositoryName, type Storage, TarFormatError, TruncatedError } from '@git-forge/core'
import { type BuildLimits, buildFromTar, buildFromTree, type BuiltSite, DEFAULT_BUILD_LIMITS, DeployError } from './deploy.ts'
import type { DeploymentRow, PagesStore } from './store.ts'

export type PagesJob = {
  readonly kind: 'pages-deploy'
  readonly owner: string
  readonly name: string
  readonly repositoryId: string
  readonly deployment: number
}

export const isPagesJob = (job: { readonly kind: string }): job is PagesJob => job.kind === 'pages-deploy'

export type PagesArtifact = { readonly id: string | null; readonly url: string | null }

export type ArtifactSource = (repository: RepositorySubject, artifact: PagesArtifact) => Promise<ReadableStream<Uint8Array> | null>

export type DeploymentContext = {
  readonly storage: Storage
  readonly store: PagesStore
  readonly limits?: BuildLimits
  readonly digests?: DigestFactory
  readonly artifacts?: ArtifactSource
  readonly log?: (event: Record<string, unknown>) => void
}

const build = async (context: DeploymentContext, repository: RepositorySubject, deployment: DeploymentRow, upload: ReadableStream<Uint8Array> | null): Promise<BuiltSite> => {
  const repo: RepositoryName = { owner: repository.owner, name: repository.name }
  const limits = context.limits ?? DEFAULT_BUILD_LIMITS
  if (deployment.source === 'branch') {
    const site = await context.store.site(repository.id)
    if (!site) throw new DeployError('Pages is not enabled for this repository')
    if (!deployment.commit_sha) throw new DeployError('deployment has no commit')
    return buildFromTree(context.storage, new ObjectDatabase(context.storage, repo), repo, deployment.commit_sha, site.source_path, limits)
  }
  let stream = upload
  if (deployment.source === 'artifact') {
    if (!context.artifacts) throw new DeployError('this instance cannot read workflow artifacts')
    stream = await context.artifacts(repository, { id: deployment.artifact_id, url: deployment.artifact_url })
    if (!stream) throw new DeployError('artifact not found')
  }
  if (!stream) throw new DeployError('upload body is missing')
  return buildFromTar(context.storage, repo, await maybeGunzip(stream), limits, context.digests)
}

export const runDeployment = async (
  context: DeploymentContext,
  repository: RepositorySubject,
  deployment: DeploymentRow,
  upload: ReadableStream<Uint8Array> | null = null,
): Promise<DeploymentRow> => {
  if (!(await context.store.start(deployment.id))) {
    await upload?.cancel().catch(() => undefined)
    return (await context.store.deployment(repository.id, deployment.id)) ?? deployment
  }
  try {
    const built = await build(context, repository, deployment, upload)
    await context.store.complete(deployment, built)
    context.log?.({ event: 'pages-deployed', repository: `${repository.owner}/${repository.name}`, deployment: deployment.id, files: built.fileCount, bytes: built.totalBytes })
  } catch (error) {
    const known = error instanceof DeployError || error instanceof TarFormatError || error instanceof TruncatedError
    await context.store.fail(deployment.id, known ? (error as Error).message : 'internal error while deploying')
    context.log?.({ event: 'pages-deploy-failed', repository: `${repository.owner}/${repository.name}`, deployment: deployment.id, error: String(error) })
    await upload?.cancel().catch(() => undefined)
    if (!known) throw error
  }
  return (await context.store.deployment(repository.id, deployment.id)) ?? deployment
}
