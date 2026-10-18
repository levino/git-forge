import { fromUtf8 } from './bytes.ts'
import type { ObjectId } from './hash.ts'
import { isTreeMode, parseCommit, parseTree } from './objects.ts'
import type { ObjectDatabase } from './repository.ts'
import { parseYaml, YamlError, type YamlValue } from './yaml.ts'

export type WorkflowEnv = Readonly<Record<string, string>>

type StepCommon = {
  readonly id?: string
  readonly name?: string
  readonly if?: string
  readonly env: WorkflowEnv
  readonly continueOnError: boolean
  readonly timeoutMinutes?: number
}

export type RunStep = StepCommon & {
  readonly kind: 'run'
  readonly run: string
  readonly shell?: string
  readonly workingDirectory?: string
}

export type UsesStep = StepCommon & {
  readonly kind: 'uses'
  readonly uses: string
  readonly with: WorkflowEnv
}

export type WorkflowStep = RunStep | UsesStep

export type WorkflowJob = {
  readonly id: string
  readonly name: string
  readonly runsOn: readonly string[]
  readonly needs: readonly string[]
  readonly env: WorkflowEnv
  readonly timeoutMinutes: number
  readonly steps: readonly WorkflowStep[]
}

export type BranchFilter = {
  readonly branches?: readonly string[]
  readonly branchesIgnore?: readonly string[]
  readonly tags?: readonly string[]
  readonly tagsIgnore?: readonly string[]
}

export type WorkflowTrigger = BranchFilter & {
  readonly event: string
}

export type Workflow = {
  readonly name?: string
  readonly triggers: readonly WorkflowTrigger[]
  readonly env: WorkflowEnv
  readonly jobs: readonly WorkflowJob[]
}

export class WorkflowError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(problems.join('; '))
    this.problems = problems
  }
}

type Mapping = { readonly [key: string]: YamlValue }

const isMapping = (value: YamlValue | undefined): value is Mapping => typeof value === 'object' && value !== null && !Array.isArray(value)

const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/

const DEFAULT_TIMEOUT_MINUTES = 360

const WORKFLOW_KEYS = new Set(['name', 'on', 'env', 'jobs', 'permissions'])

const JOB_KEYS = new Set(['name', 'runs-on', 'needs', 'env', 'timeout-minutes', 'steps', 'permissions'])

const STEP_KEYS = new Set(['id', 'name', 'if', 'env', 'continue-on-error', 'timeout-minutes', 'run', 'shell', 'working-directory', 'uses', 'with'])

class Collector {
  readonly problems: string[] = []

  fail(path: string, message: string): void {
    this.problems.push(`${path}: ${message}`)
  }

  unsupported(value: Mapping, allowed: ReadonlySet<string>, path: string): void {
    for (const key of Object.keys(value)) if (!allowed.has(key)) this.fail(path === '' ? key : `${path}.${key}`, 'is not supported yet')
  }

  scalarString(value: YamlValue | undefined, path: string): string | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
    this.fail(path, 'expected a string')
    return undefined
  }

  stringList(value: YamlValue | undefined, path: string): string[] | undefined {
    if (value === undefined || value === null) return undefined
    if (!Array.isArray(value)) {
      const single = this.scalarString(value, path)
      return single === undefined ? undefined : [single]
    }
    return value.flatMap((item, index) => this.scalarString(item, `${path}[${index}]`) ?? [])
  }

  env(value: YamlValue | undefined, path: string): WorkflowEnv {
    if (value === undefined || value === null) return {}
    if (!isMapping(value)) {
      this.fail(path, 'expected a mapping')
      return {}
    }
    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(value)) result[key] = this.scalarString(item, `${path}.${key}`) ?? ''
    return result
  }

  positiveNumber(value: YamlValue | undefined, path: string): number | undefined {
    if (value === undefined || value === null) return undefined
    if (typeof value === 'number' && value > 0) return value
    this.fail(path, 'expected a positive number')
    return undefined
  }

  condition(value: YamlValue | undefined, path: string): string | undefined {
    const text = this.scalarString(value, path)
    if (text === undefined) return undefined
    const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text)
    return (match ? match[1]! : text).trim()
  }
}

const optional = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }

const parseTriggers = (value: YamlValue | undefined, c: Collector): WorkflowTrigger[] => {
  if (value === undefined || value === null) {
    c.fail('on', 'is required')
    return []
  }
  if (typeof value === 'string') return [{ event: value }]
  if (Array.isArray(value)) return (c.stringList(value, 'on') ?? []).map((event) => ({ event }))
  if (!isMapping(value)) {
    c.fail('on', 'expected a string, a sequence or a mapping')
    return []
  }
  return Object.entries(value).map(([event, filter]) => {
    if (!isMapping(filter)) return { event }
    const path = `on.${event}`
    return {
      event,
      ...optional('branches', c.stringList(filter['branches'], `${path}.branches`)),
      ...optional('branchesIgnore', c.stringList(filter['branches-ignore'], `${path}.branches-ignore`)),
      ...optional('tags', c.stringList(filter['tags'], `${path}.tags`)),
      ...optional('tagsIgnore', c.stringList(filter['tags-ignore'], `${path}.tags-ignore`)),
    }
  })
}

const parseStep = (value: YamlValue, path: string, c: Collector): WorkflowStep | null => {
  if (!isMapping(value)) {
    c.fail(path, 'expected a mapping')
    return null
  }
  c.unsupported(value, STEP_KEYS, path)
  const common: StepCommon = {
    ...optional('id', c.scalarString(value['id'], `${path}.id`)),
    ...optional('name', c.scalarString(value['name'], `${path}.name`)),
    ...optional('if', c.condition(value['if'], `${path}.if`)),
    env: c.env(value['env'], `${path}.env`),
    continueOnError: value['continue-on-error'] === true,
    ...optional('timeoutMinutes', c.positiveNumber(value['timeout-minutes'], `${path}.timeout-minutes`)),
  }
  const run = c.scalarString(value['run'], `${path}.run`)
  const uses = c.scalarString(value['uses'], `${path}.uses`)
  if ((run === undefined) === (uses === undefined)) {
    c.fail(path, 'a step needs exactly one of "run" or "uses"')
    return null
  }
  if (run !== undefined) {
    return {
      ...common,
      kind: 'run',
      run,
      ...optional('shell', c.scalarString(value['shell'], `${path}.shell`)),
      ...optional('workingDirectory', c.scalarString(value['working-directory'], `${path}.working-directory`)),
    }
  }
  return { ...common, kind: 'uses', uses: uses!, with: c.env(value['with'], `${path}.with`) }
}

const parseRunsOn = (value: YamlValue | undefined, path: string, c: Collector): string[] => {
  if (isMapping(value)) return c.stringList(value['labels'], `${path}.labels`) ?? []
  const labels = c.stringList(value, path)
  if (!labels || labels.length === 0) c.fail(path, 'is required')
  return labels ?? []
}

const parseJob = (id: string, value: YamlValue, c: Collector): WorkflowJob | null => {
  const path = `jobs.${id}`
  if (!JOB_ID.test(id)) c.fail(path, 'job ids must start with a letter or "_" and contain only letters, digits, "-" and "_"')
  if (!isMapping(value)) {
    c.fail(path, 'expected a mapping')
    return null
  }
  if (value['uses'] !== undefined) c.fail(path, 'reusable workflows are not supported yet')
  else c.unsupported(value, JOB_KEYS, path)
  const steps = Array.isArray(value['steps']) ? value['steps'] : []
  if (steps.length === 0) c.fail(`${path}.steps`, 'needs at least one step')
  return {
    id,
    name: c.scalarString(value['name'], `${path}.name`) ?? id,
    runsOn: parseRunsOn(value['runs-on'], `${path}.runs-on`, c),
    needs: c.stringList(value['needs'], `${path}.needs`) ?? [],
    env: c.env(value['env'], `${path}.env`),
    timeoutMinutes: c.positiveNumber(value['timeout-minutes'], `${path}.timeout-minutes`) ?? DEFAULT_TIMEOUT_MINUTES,
    steps: steps.flatMap((step, index) => parseStep(step, `${path}.steps[${index}]`, c) ?? []),
  }
}

export const jobLevels = (jobs: readonly WorkflowJob[]): WorkflowJob[][] => {
  const byId = new Map(jobs.map((job) => [job.id, job]))
  for (const job of jobs) for (const need of job.needs) if (!byId.has(need)) throw new WorkflowError([`jobs.${job.id}.needs: unknown job "${need}"`])
  const levels: WorkflowJob[][] = []
  const placed = new Set<string>()
  while (placed.size < jobs.length) {
    const level = jobs.filter((job) => !placed.has(job.id) && job.needs.every((need) => placed.has(need)))
    if (level.length === 0) throw new WorkflowError(['jobs: dependency cycle in "needs"'])
    for (const job of level) placed.add(job.id)
    levels.push(level)
  }
  return levels
}

export const parseWorkflow = (source: string): Workflow => {
  let document: YamlValue
  try {
    document = parseYaml(source)
  } catch (error) {
    if (error instanceof YamlError) throw new WorkflowError([error.message])
    throw error
  }
  const c = new Collector()
  if (!isMapping(document)) throw new WorkflowError(['workflow must be a mapping'])
  c.unsupported(document, WORKFLOW_KEYS, '')
  const jobsValue = document['jobs']
  const jobs = isMapping(jobsValue) ? Object.entries(jobsValue).flatMap(([id, job]) => parseJob(id, job, c) ?? []) : []
  if (jobs.length === 0) c.fail('jobs', 'needs at least one job')
  const workflow: Workflow = {
    ...optional('name', c.scalarString(document['name'], 'name')),
    triggers: parseTriggers(document['on'], c),
    env: c.env(document['env'], 'env'),
    jobs,
  }
  if (c.problems.length > 0) throw new WorkflowError(c.problems)
  jobLevels(workflow.jobs)
  return workflow
}

const escapeRegExp = (text: string): string => text.replace(/[.+^$()|[\]\\{}]/g, '\\$&')

export const filterPatternToRegExp = (pattern: string): RegExp => {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*'
      i++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '.?'
    else source += escapeRegExp(char)
  }
  return new RegExp(`^${source}$`)
}

export const matchesFilters = (name: string, include: readonly string[] | undefined, ignore: readonly string[] | undefined): boolean => {
  if (ignore && ignore.some((pattern) => filterPatternToRegExp(pattern).test(name))) return false
  if (!include) return true
  let matched = false
  for (const pattern of include) {
    if (pattern.startsWith('!')) {
      if (filterPatternToRegExp(pattern.slice(1)).test(name)) matched = false
    } else if (filterPatternToRegExp(pattern).test(name)) matched = true
  }
  return matched
}

export const triggeredByPush = (workflow: Workflow, ref: string): boolean =>
  workflow.triggers.some((trigger) => {
    if (trigger.event !== 'push') return false
    if (ref.startsWith('refs/heads/')) {
      if (!trigger.branches && !trigger.branchesIgnore && (trigger.tags || trigger.tagsIgnore)) return false
      return matchesFilters(ref.slice('refs/heads/'.length), trigger.branches, trigger.branchesIgnore)
    }
    if (ref.startsWith('refs/tags/')) {
      if (!trigger.tags && !trigger.tagsIgnore && (trigger.branches || trigger.branchesIgnore)) return false
      return matchesFilters(ref.slice('refs/tags/'.length), trigger.tags, trigger.tagsIgnore)
    }
    return false
  })

export type WorkflowFile = {
  readonly path: string
  readonly source: string
}

export const WORKFLOW_DIRECTORY = '.github/workflows'

export const readWorkflowFiles = async (odb: ObjectDatabase, commitId: ObjectId): Promise<WorkflowFile[]> => {
  const commit = await odb.read(await odb.peel(commitId))
  if (!commit || commit.type !== 'commit') return []
  let tree: ObjectId = parseCommit(commit.data).tree
  for (const segment of WORKFLOW_DIRECTORY.split('/')) {
    const object = await odb.read(tree)
    if (!object || object.type !== 'tree') return []
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && isTreeMode(candidate.mode))
    if (!entry) return []
    tree = entry.id
  }
  const directory = await odb.read(tree)
  if (!directory || directory.type !== 'tree') return []
  const files: WorkflowFile[] = []
  for (const entry of parseTree(directory.data)) {
    if (isTreeMode(entry.mode) || !/\.ya?ml$/.test(entry.name)) continue
    const blob = await odb.read(entry.id)
    if (blob?.type === 'blob') files.push({ path: `${WORKFLOW_DIRECTORY}/${entry.name}`, source: fromUtf8(blob.data) })
  }
  return files
}
