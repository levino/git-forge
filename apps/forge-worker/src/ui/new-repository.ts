import { AccountsError } from '@git-forge/accounts'
import type { ImportPhase, ImportState, RepositoryName } from '@git-forge/core'
import { HttpError, type ForgeServices, type NewRepository, type UiSession } from '../app.ts'
import type { GithubProgress, GithubStage } from '../github-import.ts'
import { repoUrl } from './repository.ts'

export type NewRepositoryAction = { readonly kind: 'redirect'; readonly location: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

const repositoryFields = (form: FormData): NewRepository => {
  const defaultBranch = field(form, 'defaultBranch')
  return { owner: field(form, 'owner'), name: field(form, 'name'), visibility: field(form, 'visibility') || 'private', ...(defaultBranch ? { defaultBranch } : {}) }
}

const failure = (error: unknown): NewRepositoryAction => {
  if (error instanceof HttpError) return { kind: 'error', status: error.status, message: error.message }
  if (error instanceof AccountsError) return { kind: 'error', status: 400, message: error.message }
  throw error
}

export const newRepositoryAction = async (forge: ForgeServices, session: UiSession, form: FormData): Promise<NewRepositoryAction> => {
  const action = form.get('action')
  const input = repositoryFields(form)
  if (input.owner === '' || input.name === '') return { kind: 'error', status: 400, message: 'Choose an owner and a repository name.' }
  try {
    if (action === 'create') {
      const created = await forge.repositories.create(session.principal, input)
      return { kind: 'redirect', location: repoUrl(created) }
    }
    if (action === 'import') {
      const url = field(form, 'url')
      const token = field(form, 'token')
      if (url === '') return { kind: 'error', status: 400, message: 'Enter the URL to import from.' }
      const started = await forge.repositories.startImport(session.principal, { ...input, url, lfs: form.get('lfs') === 'on', metadata: form.get('metadata') === 'on', ...(token ? { token } : {}) })
      return { kind: 'redirect', location: repoUrl(started, 'import') }
    }
  } catch (error) {
    return failure(error)
  }
  return { kind: 'error', status: 400, message: 'Unknown action.' }
}

export const IMPORT_PHASES: Readonly<Record<ImportPhase, string>> = {
  discover: 'Listing upstream refs',
  graph: 'Reading the commit graph',
  fetch: 'Fetching objects',
  lfs: 'Copying LFS objects',
  refs: 'Updating refs',
  metadata: 'Importing issues, pull requests and releases',
  done: 'Done',
  failed: 'Failed',
}

export const importRunning = (state: ImportState): boolean => state.phase !== 'done' && state.phase !== 'failed'

export const importStateFor = async (forge: ForgeServices, session: UiSession | null, repo: RepositoryName): Promise<ImportState | null> => {
  if (!session) return null
  try {
    return await forge.repositories.importStatus(session.principal, repo)
  } catch (error) {
    if (error instanceof HttpError) return null
    throw error
  }
}

const GITHUB_STAGES: Readonly<Record<GithubStage, string>> = {
  labels: 'Labels',
  milestones: 'Milestones',
  pulls: 'Pull requests',
  issues: 'Issues',
  comments: 'Comments',
  reviews: 'Reviews',
  'review-comments': 'Review comments',
  releases: 'Releases',
  assets: 'Release assets',
  done: 'Done',
}

const COUNT_NAMES: Readonly<Record<string, string>> = { pulls: 'pull requests', reviewComments: 'review comments', assets: 'release assets', skipped: 'skipped (number in use)' }

export const metadataStatus = (state: ImportState): { readonly stage: string; readonly counts: string; readonly waitUntil: string | null } | null => {
  if (!state.metadata) return null
  const progress = state.metadata.progress as GithubProgress | null
  const counts = Object.entries(progress?.counts ?? {}).map(([kind, count]) => `${count} ${COUNT_NAMES[kind] ?? kind}`)
  return { stage: progress ? GITHUB_STAGES[progress.stage] : 'Waiting for the Git import', counts: counts.join(', ') || 'nothing yet', waitUntil: state.metadata.waitUntil ?? null }
}
