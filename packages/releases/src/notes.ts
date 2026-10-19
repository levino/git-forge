import { type Database, sql } from '@git-forge/accounts'
import { commitsBetween, entryAt, ObjectDatabase, type ObjectId, parseYaml, readBlobContent, readCommit, type RepositoryName, resolveCommitish, type Storage, type YamlValue } from '@git-forge/core'

export type NotePull = { readonly number: number; readonly title: string; readonly author: string | null; readonly labels: readonly string[]; readonly firstContribution: boolean }

type Filter = { readonly labels: readonly string[]; readonly authors: readonly string[] }

export type NotesConfig = {
  readonly exclude: Filter
  readonly categories: readonly { readonly title: string; readonly labels: readonly string[]; readonly exclude: Filter }[]
}

const strings = (value: YamlValue | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

const record = (value: YamlValue | undefined): Record<string, YamlValue> => (value && typeof value === 'object' && !Array.isArray(value) ? value : {})

const filter = (value: YamlValue | undefined): Filter => ({ labels: strings(record(value).labels), authors: strings(record(value).authors) })

export const parseNotesConfig = (text: string): NotesConfig => {
  const changelog = record(record(parseYaml(text)).changelog)
  return {
    exclude: filter(changelog.exclude),
    categories: (Array.isArray(changelog.categories) ? changelog.categories : []).map((entry) => ({
      title: String(record(entry).title ?? ''),
      labels: strings(record(entry).labels),
      exclude: filter(record(entry).exclude),
    })),
  }
}

const excluded = (pull: NotePull, rule: Filter): boolean =>
  pull.labels.some((label) => rule.labels.includes(label) || rule.labels.includes('*')) || (pull.author !== null && (rule.authors.includes(pull.author) || rule.authors.includes('*')))

export const buildReleaseNotes = (input: { readonly pulls: readonly NotePull[]; readonly pullUrl: (number: number) => string; readonly changelogUrl: string; readonly config: NotesConfig | null }): string => {
  const pulls = input.pulls.filter((pull) => !input.config || !excluded(pull, input.config.exclude))
  const line = (pull: NotePull) => `* ${pull.title}${pull.author ? ` by @${pull.author}` : ''} in ${input.pullUrl(pull.number)}`
  const sections: string[] = []
  if (pulls.length > 0) {
    const categories = input.config?.categories ?? []
    if (categories.length === 0) sections.push(`## What's Changed\n${pulls.map(line).join('\n')}`)
    else {
      const placed = new Set<number>()
      const blocks = categories.flatMap((category) => {
        const members = pulls.filter(
          (pull) => !placed.has(pull.number) && pull.labels.some((label) => category.labels.includes(label) || category.labels.includes('*')) && !excluded(pull, category.exclude),
        )
        for (const pull of members) placed.add(pull.number)
        return members.length > 0 ? [`### ${category.title}\n${members.map(line).join('\n')}`] : []
      })
      const rest = pulls.filter((pull) => !placed.has(pull.number))
      if (rest.length > 0) blocks.push(`### Other Changes\n${rest.map(line).join('\n')}`)
      sections.push(`## What's Changed\n${blocks.join('\n')}`)
    }
  }
  const newcomers = pulls.filter((pull) => pull.firstContribution && pull.author)
  if (newcomers.length > 0) sections.push(`## New Contributors\n${newcomers.map((pull) => `* @${pull.author} made their first contribution in ${input.pullUrl(pull.number)}`).join('\n')}`)
  sections.push(`**Full Changelog**: ${input.changelogUrl}`)
  return sections.join('\n\n')
}

type MergedRow = { number: number; title: string; issue_id: number; merge_commit_sha: string | null; login: string | null; author_kind: string; slug: string | null }

export type NotesInput = {
  readonly tagName: string
  readonly targetCommitish: string
  readonly previousTagName: string | null
  readonly configurationFilePath: string | null
}

export type NotesRange = { readonly previous: string | null; readonly target: ObjectId; readonly pulls: readonly NotePull[]; readonly config: NotesConfig | null }

const readConfig = async (odb: ObjectDatabase, commit: ObjectId, paths: readonly string[]): Promise<NotesConfig | null> => {
  const details = await readCommit(odb, commit)
  if (!details) return null
  for (const path of paths) {
    const entry = await entryAt(odb, details.tree, path.split('/'))
    const content = entry ? await readBlobContent(odb, entry) : null
    if (content?.kind === 'text') {
      try {
        return parseNotesConfig(content.text)
      } catch {
        return null
      }
    }
  }
  return null
}

export const collectReleaseNotes = async (db: Database, storage: Storage, repo: RepositoryName, repositoryId: string, input: NotesInput): Promise<NotesRange | null> => {
  const target = (await resolveCommitish(storage, repo, `refs/tags/${input.tagName}`)) ?? (await resolveCommitish(storage, repo, input.targetCommitish))
  if (!target) return null
  const previousCommit = input.previousTagName ? await resolveCommitish(storage, repo, `refs/tags/${input.previousTagName}`) : null
  const odb = new ObjectDatabase(storage, repo)
  const range = new Set(await commitsBetween(odb, previousCommit, target))
  const rows = await db.all<MergedRow>(
    sql(
      `SELECT i.number, i.title, i.id AS issue_id, p.merge_commit_sha, a.login, i.author_kind, ap.slug FROM pull_requests p JOIN issues i ON i.id = p.issue_id
       LEFT JOIN accounts a ON i.author_kind = 'user' AND a.id = i.author_id LEFT JOIN apps ap ON i.author_kind = 'app' AND ap.id = i.author_id
       WHERE i.repository_id = ? AND p.merged_at IS NOT NULL ORDER BY p.merged_at, i.number`,
      repositoryId,
    ),
  )
  const author = (row: MergedRow) => row.login ?? (row.slug ? `${row.slug}[bot]` : null)
  const first = new Map<string, number>()
  for (const row of rows) if (author(row) && !first.has(author(row)!)) first.set(author(row)!, row.number)
  const chosen = rows.filter((row) => row.merge_commit_sha !== null && range.has(row.merge_commit_sha))
  const labels = chosen.length
    ? await db.all<{ issue_id: number; name: string }>(
        sql(`SELECT il.issue_id, l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id WHERE il.issue_id IN (${chosen.map(() => '?').join(', ')})`, ...chosen.map((row) => row.issue_id)),
      )
    : []
  const paths = input.configurationFilePath ? [input.configurationFilePath] : ['.github/release.yml', '.github/release.yaml']
  return {
    previous: input.previousTagName,
    target,
    config: await readConfig(odb, target, paths),
    pulls: chosen.map((row) => ({
      number: row.number,
      title: row.title,
      author: author(row),
      labels: labels.filter((label) => label.issue_id === row.issue_id).map((label) => label.name),
      firstContribution: author(row) !== null && first.get(author(row)!) === row.number,
    })),
  }
}
