import type { AssetRow, ReleaseRow } from '@git-forge/releases'
import type { ForgeServices } from '../app.ts'
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

export const listReleases = async (forge: ForgeServices, repo: OpenRepository, page: number): Promise<{ readonly releases: readonly ReleaseView[]; readonly more: boolean }> => {
  const rows = await forge.releases.list(repo.subject, repo.canWrite, RELEASES_PER_PAGE + 1, (page - 1) * RELEASES_PER_PAGE)
  const shown = rows.slice(0, RELEASES_PER_PAGE)
  const assets = shown.length > 0 ? await forge.releases.assets(shown.map((release) => release.id)) : []
  return { releases: await Promise.all(shown.map((release) => view(repo, release, assets))), more: rows.length > RELEASES_PER_PAGE }
}

export const releaseByTag = async (forge: ForgeServices, repo: OpenRepository, tag: string): Promise<ReleaseView | null> => {
  const release = await forge.releases.byTag(repo.subject, tag, repo.canWrite)
  return release ? view(repo, release, await forge.releases.assets([release.id])) : null
}
