import { ApiError } from '@git-forge/notifications'
import type { AssetRow, ReleaseRow } from '@git-forge/releases'
import type { ForgeServices } from '../app.ts'
import type { FormOutcome } from './collaboration.ts'
import { renderMarkdown } from './markdown.ts'
import { blobUrl, type OpenRepository, rawUrl, repoUrl } from './repository.ts'

export const RELEASES_PER_PAGE = 10

export type ReleaseView = {
  readonly release: ReleaseRow
  readonly title: string
  readonly html: string | null
  readonly assets: readonly AssetRow[]
}

export const releaseUrl = (repo: OpenRepository, tag: string): string => repoUrl(repo.name, 'releases', 'tag', encodeURIComponent(tag))

export const assetUrl = (repo: OpenRepository, tag: string, name: string): string =>
  repoUrl(repo.name, 'releases', 'download', encodeURIComponent(tag), encodeURIComponent(name))

const view = async (repo: OpenRepository, release: ReleaseRow, assets: readonly AssetRow[]): Promise<ReleaseView> => ({
  release,
  title: release.name?.trim() || release.tag_name,
  html: release.body ? await renderMarkdown(release.body, { blob: blobUrl(repo.name, release.tag_name, []), raw: rawUrl(repo.name, release.tag_name, []), directory: '' }) : null,
  assets: assets.filter((asset) => asset.release_id === release.id),
})

export const listReleases = async (forge: ForgeServices, repo: OpenRepository, page: number): Promise<{ readonly releases: readonly ReleaseView[]; readonly more: boolean; readonly latest: number | null }> => {
  const rows = await forge.releases.list(repo.subject, repo.canWrite, RELEASES_PER_PAGE + 1, (page - 1) * RELEASES_PER_PAGE)
  const shown = rows.slice(0, RELEASES_PER_PAGE)
  const assets = shown.length > 0 ? await forge.releases.assets(shown.map((release) => release.id)) : []
  return { releases: await Promise.all(shown.map((release) => view(repo, release, assets))), more: rows.length > RELEASES_PER_PAGE, latest: (await forge.releases.latest(repo.subject))?.id ?? null }
}

export const releaseByTag = async (forge: ForgeServices, repo: OpenRepository, tag: string): Promise<ReleaseView | null> => {
  const release = await forge.releases.byTag(repo.subject, tag, repo.canWrite)
  return release ? view(repo, release, await forge.releases.assets([release.id])) : null
}

export const archiveUrl = (repo: OpenRepository, tag: string, format: 'zip' | 'tar.gz'): string => repoUrl(repo.name, 'archive', 'refs', 'tags', `${encodeURIComponent(tag)}.${format}`)

export const editReleaseUrl = (repo: OpenRepository, tag: string): string => repoUrl(repo.name, 'releases', 'edit', encodeURIComponent(tag))

export const latestRelease = async (forge: ForgeServices, repo: OpenRepository): Promise<ReleaseRow | null> => forge.releases.latest(repo.subject)

export type ReleaseValues = {
  readonly tag: string
  readonly target: string
  readonly title: string
  readonly body: string
  readonly draft: boolean
  readonly prerelease: boolean
}

export const releaseValues = (release: ReleaseRow | null, defaults: Partial<ReleaseValues> = {}): ReleaseValues => ({
  tag: release?.tag_name ?? defaults.tag ?? '',
  target: release?.target_commitish ?? defaults.target ?? '',
  title: release?.name ?? '',
  body: release?.body ?? '',
  draft: release ? release.draft === 1 : false,
  prerelease: release ? release.prerelease === 1 : false,
})

export type ReleaseFormResult = { readonly outcome: FormOutcome | null; readonly values: ReleaseValues }

export const runReleaseForm = async (forge: ForgeServices, request: Request, repo: OpenRepository, release: ReleaseRow | null): Promise<ReleaseFormResult> => {
  const form = await request.formData()
  const text = (name: string) => String(form.get(name) ?? '')
  const values: ReleaseValues = { tag: text('tag_name').trim(), target: text('target_commitish').trim(), title: text('name'), body: text('body'), draft: form.has('draft'), prerelease: form.has('prerelease') }
  const session = await forge.verifySessionWrite(request)
  if (!session) return { values, outcome: { kind: 'error', status: 403, message: 'The form expired or you are not signed in. Reload the page and try again.' } }
  const operations = forge.releases.write(request, session.principal)
  const { owner, name } = repo.name
  const input = { tag_name: values.tag, target_commitish: values.target || undefined, name: values.title || null, body: values.body || null, draft: values.draft, prerelease: values.prerelease }
  try {
    switch (text('intent')) {
      case 'generate': {
        const notes = await operations.generateNotes(owner, name, { tag_name: values.tag, ...(values.target ? { target_commitish: values.target } : {}) })
        return { outcome: null, values: { ...values, title: values.title || notes.name, body: values.body.trim() ? `${values.body.trimEnd()}\n\n${notes.body}` : notes.body } }
      }
      case 'delete':
        if (!release) return { values, outcome: { kind: 'error', status: 404, message: 'Not found.' } }
        await operations.remove(owner, name, release.id)
        return { values, outcome: { kind: 'redirect', location: repoUrl(repo.name, 'releases') } }
      default: {
        const saved = release ? await operations.update(owner, name, release.id, input) : await operations.create(owner, name, input)
        return { values, outcome: { kind: 'redirect', location: releaseUrl(repo, saved.tag_name) } }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) return { values, outcome: { kind: 'error', status: error.status, message: error.message } }
    throw error
  }
}
