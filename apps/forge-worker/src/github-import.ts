import { first, sql } from '@git-forge/accounts'
import {
  importComment,
  type ImportedIssue,
  type ImportedPull,
  type ImportedUser,
  importIssue,
  importLabel,
  importMilestone,
  importReview,
  importReviewComment,
  type ImportOrigin,
  mapImportedUser,
  nextImportedPull,
  objectDatabase,
  type Scope,
  type StateReason,
} from '@git-forge/collaboration'
import type { DigestFactory, FetchFunction, ImportMetadataResult } from '@git-forge/core'
import { type ReleaseStore, storeAsset } from '@git-forge/releases'

export type GithubStage = 'labels' | 'milestones' | 'pulls' | 'issues' | 'comments' | 'reviews' | 'review-comments' | 'releases' | 'assets' | 'done'

export type GithubAsset = {
  readonly release: number
  readonly name: string
  readonly label: string | null
  readonly contentType: string
  readonly size: number
  readonly url: string
  readonly digest: string | null
  readonly uploader: string
  readonly createdAt: number
}

export type GithubProgress = {
  readonly stage: GithubStage
  readonly next: string | null
  readonly pull?: number
  readonly assets: readonly GithubAsset[]
  readonly counts: Readonly<Record<string, number>>
}

export type GithubImportOptions = {
  readonly scope: Scope
  readonly releases: ReleaseStore
  readonly url: string
  readonly token: string | null
  readonly fetch?: FetchFunction
  readonly digests?: DigestFactory
}

type User = { readonly login: string } | null
type Label = { readonly name: string; readonly color: string; readonly description?: string | null }
type Issue = {
  readonly number: number
  readonly html_url: string
  readonly title: string
  readonly body: string | null
  readonly user: User
  readonly state: 'open' | 'closed'
  readonly state_reason?: string | null
  readonly locked: boolean
  readonly active_lock_reason?: string | null
  readonly labels: readonly (Label | string)[]
  readonly assignees?: readonly User[] | null
  readonly milestone: { readonly number: number } | null
  readonly created_at: string
  readonly updated_at: string
  readonly closed_at: string | null
  readonly pull_request?: unknown
}
type Branch = { readonly ref: string; readonly sha: string; readonly repo: { readonly full_name: string } | null }
type Pull = Issue & { readonly draft?: boolean; readonly merged_at: string | null; readonly merge_commit_sha: string | null; readonly head: Branch; readonly base: Branch }
type Comment = { readonly id: number; readonly html_url: string; readonly user: User; readonly body: string | null; readonly created_at: string; readonly updated_at: string }
type Review = Omit<Comment, 'created_at' | 'updated_at'> & { readonly state: string; readonly commit_id: string | null; readonly submitted_at: string | null }
type ReviewComment = Comment & {
  readonly pull_request_url: string
  readonly pull_request_review_id: number | null
  readonly in_reply_to_id?: number
  readonly path: string
  readonly commit_id: string
  readonly original_commit_id?: string
  readonly line?: number | null
  readonly original_line?: number | null
  readonly side?: 'LEFT' | 'RIGHT' | null
  readonly start_line?: number | null
  readonly original_start_line?: number | null
  readonly start_side?: 'LEFT' | 'RIGHT' | null
}
type Asset = { readonly url: string; readonly name: string; readonly label: string | null; readonly content_type: string; readonly size: number; readonly digest?: string | null; readonly uploader: User; readonly created_at: string }
type Release = {
  readonly tag_name: string
  readonly target_commitish: string
  readonly name: string | null
  readonly body: string | null
  readonly draft: boolean
  readonly prerelease: boolean
  readonly author: User
  readonly created_at: string
  readonly published_at: string | null
  readonly assets: readonly Asset[]
}

const STAGES: readonly GithubStage[] = ['labels', 'milestones', 'pulls', 'issues', 'comments', 'reviews', 'review-comments', 'releases', 'assets', 'done']

const PATHS: Partial<Record<GithubStage, string>> = {
  labels: '/labels?per_page=100',
  milestones: '/milestones?state=all&per_page=100',
  pulls: '/pulls?state=all&sort=created&direction=asc&per_page=100',
  issues: '/issues?state=all&sort=created&direction=asc&per_page=100',
  comments: '/issues/comments?sort=created&direction=asc&per_page=100',
  'review-comments': '/pulls/comments?sort=created&direction=asc&per_page=100',
  releases: '/releases?per_page=100',
}

const STATE_REASONS: readonly StateReason[] = ['completed', 'not_planned', 'reopened', 'duplicate']

export class RateLimitedError extends Error {
  constructor(readonly until: number) {
    super(`GitHub rate limit reached until ${new Date(until).toISOString()}`)
  }
}

export const githubRepository = (url: string): { readonly api: string; readonly path: string } | null => {
  try {
    const parsed = new URL(url)
    const [owner, name, ...rest] = parsed.pathname.split('/').filter(Boolean)
    if (!owner || !name || rest.length > 0) return null
    return { api: parsed.host === 'github.com' ? 'https://api.github.com' : `${parsed.origin}/api/v3`, path: `/repos/${owner}/${name.replace(/\.git$/, '')}` }
  } catch {
    return null
  }
}

export const initialGithubProgress: GithubProgress = { stage: 'labels', next: null, assets: [], counts: {} }

const time = (value: string | null | undefined): number | null => (value ? Date.parse(value) : null)

const numberOf = (url: string): number => Number(url.slice(url.lastIndexOf('/') + 1))

export const githubImportStep = async (options: GithubImportOptions, previous: GithubProgress | null): Promise<ImportMetadataResult & { readonly progress: GithubProgress }> => {
  const { scope } = options
  const repository = githubRepository(options.url)
  if (!repository) throw new Error(`${options.url} is not a GitHub repository URL`)
  const base = `${repository.api}${repository.path}`
  const send = options.fetch ?? ((request: Request) => fetch(request))
  const counts: Record<string, number> = { ...previous?.counts }
  const count = (kind: string, done: boolean | string) => {
    const key = done === 'taken' ? 'skipped' : kind
    if (done === true || done === 'imported' || done === 'taken') counts[key] = (counts[key] ?? 0) + 1
  }
  let waitUntil: number | null = null
  const users = new Map<string, Promise<ImportedUser>>()
  const matchLogin = repository.api === 'https://api.github.com'
  const user = (value: User): Promise<ImportedUser> => {
    const login = value?.login ?? 'ghost'
    if (!users.has(login)) users.set(login, mapImportedUser(scope, login, matchLogin))
    return users.get(login)!
  }
  const origin = async (source: string, item: Comment): Promise<ImportOrigin> => ({
    source,
    url: item.html_url,
    author: await user(item.user),
    createdAt: Date.parse(item.created_at),
    updatedAt: Date.parse(item.updated_at),
  })

  const call = async (url: string, headers: Record<string, string> = {}, redirect: 'follow' | 'manual' = 'follow'): Promise<Response> => {
    if (new URL(url).origin !== new URL(repository.api).origin) throw new Error(`refusing to fetch ${url} with the import token`)
    const response = await send(
      new Request(url, {
        redirect,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'git-forge-import',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...headers,
        },
      }),
    )
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
    const retry = response.headers.get('retry-after')
    if ((response.status === 403 || response.status === 429) && (remaining === '0' || retry !== null)) {
      throw new RateLimitedError(retry !== null ? scope.now() + Number(retry) * 1000 : reset)
    }
    if (remaining === '0' && reset > 0) waitUntil = reset
    return response
  }

  const page = async <T>(url: string): Promise<{ readonly items: readonly T[]; readonly next: string | null; readonly save: () => Promise<void> }> => {
    const cached = await first<{ etag: string; next: string | null }>(scope.db, sql('SELECT etag, next FROM import_etags WHERE repository_id = ? AND url = ?', scope.repository.id, url))
    const response = await call(url, cached ? { 'If-None-Match': cached.etag } : {})
    if (response.status === 304 && cached) return { items: [], next: cached.next, save: async () => {} }
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`)
    const items = (await response.json()) as T[]
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null
    const etag = response.headers.get('etag')
    const save = async () => {
      if (!etag) return
      await scope.db.run(
        sql(
          'INSERT INTO import_etags (repository_id, url, etag, next) VALUES (?, ?, ?, ?) ON CONFLICT (repository_id, url) DO UPDATE SET etag = excluded.etag, next = excluded.next',
          scope.repository.id,
          url,
          etag,
          next,
        ),
      )
    }
    return { items, next, save }
  }

  const issueOf = async (item: Issue, pull?: ImportedPull, note?: string): Promise<ImportedIssue> => ({
    source: `issue:${item.number}`,
    url: item.html_url,
    author: await user(item.user),
    createdAt: Date.parse(item.created_at),
    updatedAt: Date.parse(item.updated_at),
    number: item.number,
    title: item.title,
    body: note ? `${note}\n\n${item.body ?? ''}` : item.body,
    state: item.state,
    stateReason: STATE_REASONS.find((reason) => reason === item.state_reason) ?? null,
    locked: item.locked,
    lockReason: item.active_lock_reason ?? null,
    labels: item.labels.map((label) => (typeof label === 'string' ? label : label.name)),
    assignees: await Promise.all((item.assignees ?? []).map(user)),
    milestone: item.milestone?.number ?? null,
    closedAt: time(item.closed_at),
    ...(pull ? { pull } : {}),
  })

  const odb = objectDatabase(scope)
  const importPull = async (item: Pull) => {
    const sameRepository = item.head.repo?.full_name.toLowerCase() === item.base.repo?.full_name.toLowerCase()
    const present = (item.state === 'closed' || sameRepository) && (await odb.has(item.head.sha)) && (await odb.has(item.base.sha))
    const pull: ImportedPull | undefined = present
      ? {
          headRef: item.head.ref,
          baseRef: item.base.ref,
          headSha: item.head.sha,
          baseSha: item.base.sha,
          draft: item.draft ?? false,
          mergedAt: time(item.merged_at),
          mergeCommitSha: item.merged_at ? item.merge_commit_sha : null,
        }
      : undefined
    const note = present ? undefined : `_Imported from pull request ${item.html_url}; its commits are not in this repository._`
    count(present ? 'pulls' : 'issues', await importIssue(scope, await issueOf(item, pull, note)))
  }

  const importReviewComments = async (item: ReviewComment) => {
    const number = numberOf(item.pull_request_url)
    const base = await origin(`review-comment:${item.id}`, item)
    const line = item.original_line ?? item.line ?? null
    const startLine = item.original_start_line ?? item.start_line ?? null
    const result = await importReviewComment(scope, number, {
      ...base,
      review: `review:${item.pull_request_review_id}`,
      inReplyTo: item.in_reply_to_id ? `review-comment:${item.in_reply_to_id}` : null,
      commitId: item.original_commit_id ?? item.commit_id,
      path: item.path,
      line,
      side: item.side ?? 'RIGHT',
      startLine,
      startSide: startLine === null ? null : (item.start_side ?? item.side ?? 'RIGHT'),
      body: item.body ?? '',
    })
    if (result !== 'unanchored') return count('reviewComments', result)
    count('comments', await importComment(scope, number, { ...base, body: `> On \`${item.path}\`${line ? ` line ${line}` : ''}:\n\n${item.body ?? ''}` }))
  }

  const importReleases = async (items: readonly Release[], queue: GithubAsset[]) => {
    for (const item of items) {
      const author = await user(item.author)
      let row = await options.releases.byTag(scope.repository.id, item.tag_name)
      if (!row) {
        row = await options.releases.create(
          scope.repository.id,
          { tagName: item.tag_name, targetCommitish: item.target_commitish, name: item.name, body: item.body, draft: item.draft, prerelease: item.prerelease },
          { kind: 'user', id: author.ref?.id ?? null, login: author.login },
          { createdAt: Date.parse(item.created_at), publishedAt: time(item.published_at) },
        )
        count('releases', true)
      }
      for (const asset of item.assets) {
        queue.push({
          release: row.id,
          name: asset.name,
          label: asset.label,
          contentType: asset.content_type,
          size: asset.size,
          url: asset.url,
          digest: asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null,
          uploader: asset.uploader?.login ?? 'ghost',
          createdAt: Date.parse(asset.created_at),
        })
      }
    }
  }

  const importAsset = async (asset: GithubAsset) => {
    if (await options.releases.assetByName(asset.release, asset.name)) return
    let response = await call(asset.url, { Accept: 'application/octet-stream' }, 'manual')
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) response = await send(new Request(location))
    if (!response.ok || !response.body) throw new Error(`GitHub answered ${response.status} for asset ${asset.name}`)
    const stored = await storeAsset(scope.storage, scope.repo, response.body, asset.size, {
      ...(asset.digest ? { sha256: asset.digest } : {}),
      ...(options.digests ? { digests: options.digests } : {}),
    })
    const uploader = await user({ login: asset.uploader })
    await options.releases.addAsset(
      asset.release,
      { name: asset.name, label: asset.label, contentType: asset.contentType, size: stored.size, oid: stored.oid },
      { kind: 'user', id: uploader.ref?.id ?? null, login: uploader.login },
      asset.createdAt,
    )
    count('assets', true)
  }

  const advance = async (progress: GithubProgress): Promise<GithubProgress> => {
    const following = (): GithubProgress => {
      const { pull: _pull, ...rest } = progress
      return { ...rest, stage: STAGES[STAGES.indexOf(progress.stage) + 1]!, next: null }
    }
    if (progress.stage === 'done') return progress
    if (progress.stage === 'assets') {
      const [asset, ...rest] = progress.assets
      if (!asset) return following()
      await importAsset(asset)
      return { ...progress, assets: rest }
    }
    if (progress.stage === 'reviews') {
      const pull = progress.pull ?? (await nextImportedPull(scope, 0))
      if (pull === null) return following()
      const result = await page<Review>(progress.next ?? `${base}/pulls/${pull}/reviews?per_page=100`)
      for (const item of result.items) {
        const at = time(item.submitted_at) ?? scope.now()
        const review = { source: `review:${item.id}`, url: item.html_url, author: await user(item.user), createdAt: at, updatedAt: at }
        count('reviews', await importReview(scope, pull, { ...review, state: item.state, body: item.body, commitId: item.commit_id }))
      }
      await result.save()
      if (result.next) return { ...progress, pull, next: result.next }
      const upcoming = await nextImportedPull(scope, pull)
      return upcoming === null ? following() : { ...progress, pull: upcoming, next: null }
    }
    const result = await page<unknown>(progress.next ?? `${base}${PATHS[progress.stage]}`)
    const assets = [...progress.assets]
    for (const raw of result.items) {
      if (progress.stage === 'labels') {
        const item = raw as Label
        count('labels', await importLabel(scope, { name: item.name, color: item.color, description: item.description ?? null }))
      } else if (progress.stage === 'milestones') {
        const item = raw as Issue & { readonly description: string | null; readonly due_on: string | null; readonly creator: User }
        count(
          'milestones',
          await importMilestone(scope, {
            number: item.number,
            title: item.title,
            description: item.description,
            state: item.state,
            dueOn: time(item.due_on),
            creator: await user(item.creator),
            createdAt: Date.parse(item.created_at),
            updatedAt: Date.parse(item.updated_at),
            closedAt: time(item.closed_at),
          }),
        )
      } else if (progress.stage === 'pulls') await importPull(raw as Pull)
      else if (progress.stage === 'issues') {
        if (!(raw as Issue).pull_request) count('issues', await importIssue(scope, await issueOf(raw as Issue)))
      } else if (progress.stage === 'comments') {
        const item = raw as Comment & { readonly issue_url: string }
        count('comments', await importComment(scope, numberOf(item.issue_url), { ...(await origin(`comment:${item.id}`, item)), body: item.body ?? '' }))
      } else if (progress.stage === 'review-comments') await importReviewComments(raw as ReviewComment)
      else if (progress.stage === 'releases') await importReleases([raw as Release], assets)
    }
    await result.save()
    const next = { ...progress, assets }
    return result.next ? { ...next, next: result.next } : { ...next, ...following(), assets }
  }

  let progress = previous ?? initialGithubProgress
  try {
    progress = await advance(progress)
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error
    waitUntil = error.until
  }
  progress = { ...progress, counts }
  return { progress, done: progress.stage === 'done', ...(waitUntil !== null ? { waitUntil: new Date(waitUntil).toISOString() } : {}) }
}
