import { fullName, gitOps, isAncestor, lsRemote, presentObjects, resolve, runGitInteractive } from './git.ts'
import { type Chunk, fits, type GitOps, type ObjectId, type PlanContext, planChunks } from './plan.ts'
import { chunkRefPrefix, parseRefspec, qualifyDestination } from './refspec.ts'
import { formatSize } from './size.ts'

export const DEFAULT_BUDGET = 80_000_000

export type PushOptions = {
  readonly remote: string
  readonly refspecs: readonly string[]
  readonly budget: number
  readonly force?: boolean
  readonly dryRun?: boolean
  readonly cwd?: string
  readonly log?: (line: string) => void
}

export type PushReport = {
  readonly chunks: number
  readonly pushes: number
  readonly upToDate: boolean
}

export type Pusher = (args: readonly string[]) => Promise<void>

const defaultPusher =
  (cwd?: string): Pusher =>
  async (args) => {
    const code = await runGitInteractive(['push', ...args], cwd)
    if (code !== 0) throw new Error(`git push ${args.join(' ')} failed${code === null ? '' : ` with exit code ${code}`}`)
  }

const nextSideIndex = (remoteRefs: ReadonlyMap<string, ObjectId>, prefix: string): number => {
  let next = 0
  for (const name of remoteRefs.keys()) {
    if (!name.startsWith(prefix)) continue
    const index = Number(name.slice(prefix.length))
    if (Number.isSafeInteger(index) && index >= next) next = index + 1
  }
  return next
}

const peelToCommit = async (id: ObjectId, cwd?: string): Promise<ObjectId | null> => resolve(`${id}^{commit}`, cwd)

export const forgePush = async (options: PushOptions, ops: GitOps = gitOps(options.cwd), push: Pusher = defaultPusher(options.cwd)): Promise<PushReport> => {
  const { cwd, remote, budget } = options
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  let chunks = 0
  let pushes = 0
  let upToDate = true
  for (const text of options.refspecs) {
    const refspec = parseRefspec(text)
    const force = refspec.force || options.force === true
    const source = await resolve(refspec.src, cwd)
    if (!source) throw new Error(`src refspec ${refspec.src} does not match any object`)
    const sourceName = await fullName(refspec.src, cwd)
    const remoteRefs = await lsRemote(remote, cwd)
    const dstText = refspec.dst ?? sourceName
    if (!dstText) throw new Error(`cannot determine the destination of ${text}; use <src>:<dst>`)
    const dst = qualifyDestination(dstText, sourceName, remoteRefs)
    const tipCommit = await peelToCommit(source, cwd)
    if (!tipCommit) throw new Error(`${refspec.src} does not point to a commit`)
    if (dst.startsWith('refs/heads/') && tipCommit !== source) throw new Error(`${dst} would point to a non-commit object`)
    const prefix = chunkRefPrefix(dst)
    const staleChunks = [...remoteRefs.keys()].filter((name) => name.startsWith(prefix))
    const current = remoteRefs.get(dst) ?? null
    if (current === source && staleChunks.length === 0) {
      log(`${dst} is up to date`)
      continue
    }
    upToDate = false
    const present = await presentObjects(remoteRefs.values(), cwd)
    if (current !== null && !force) {
      if (!present.has(current) || !(await isAncestor(current, source, cwd))) {
        throw new Error(`${dst} on ${remote} is not an ancestor of ${refspec.src}; fetch first or force with +${refspec.src}:${dst}`)
      }
    }
    let sideIndex = nextSideIndex(remoteRefs, prefix)
    const created: string[] = []
    const context: PlanContext = {
      ops,
      budget,
      negatives: new Set([...remoteRefs.values()].filter((id) => present.has(id))),
      sideRef: () => {
        const ref = `${prefix}${sideIndex++}`
        created.push(ref)
        return ref
      },
    }
    const pushChunk = async (chunk: Chunk) => {
      chunks++
      const forced = force && chunk.ref === dst
      log(`chunk ${chunks}: ${chunk.commit.slice(0, 12)} -> ${chunk.ref} (${formatSize(chunk.bytes)})`)
      if (!options.dryRun) {
        await push([remote, `${forced ? '+' : ''}${chunk.commit}:${chunk.ref}`])
        pushes++
      }
    }
    const whole = await fits(context, source)
    if (!whole.ok) {
      const mainRef = dst.startsWith('refs/heads/') ? dst : context.sideRef()
      log(`pushing ${refspec.src} to ${dst} in chunks of at most ${formatSize(budget)}`)
      for await (const chunk of planChunks(context, tipCommit, mainRef)) await pushChunk(chunk)
    }
    const deletions = [...new Set([...staleChunks, ...created])].map((name) => `:${name}`)
    const finalArgs = [...(deletions.length > 0 ? ['--atomic'] : []), remote, `${force ? '+' : ''}${source}:${dst}`, ...deletions]
    log(`final: ${source.slice(0, 12)} -> ${dst}${deletions.length > 0 ? `, removing ${deletions.length} temporary ref(s)` : ''}`)
    if (!options.dryRun) {
      await push(finalArgs)
      pushes++
    }
  }
  return { chunks, pushes, upToDate }
}
