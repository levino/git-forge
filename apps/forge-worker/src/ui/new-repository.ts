import { AccountsError } from '@git-forge/accounts'
import type { ImportPhase, ImportState } from '@git-forge/core'
import { HttpError, type ForgeServices, type NewRepository, type UiSession } from '../app.ts'
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
      const started = await forge.repositories.startImport(session.principal, { ...input, url, lfs: form.get('lfs') === 'on', ...(token ? { token } : {}) })
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
  done: 'Done',
  failed: 'Failed',
}

export const importRunning = (state: ImportState): boolean => state.phase !== 'done' && state.phase !== 'failed'
