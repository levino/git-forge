import { fromUtf8 } from './bytes.ts'
import type { ObjectId } from './hash.ts'
import { isTreeMode, parseCommit, parseTree } from './objects.ts'
import type { ObjectDatabase } from './repository.ts'
import { parseCron } from './cron.ts'
import { parseYaml, YamlError, type YamlValue } from './yaml.ts'

export type WorkflowEnv = Readonly<Record<string, string>>

type StepCommon = {
  readonly id?: string
  readonly name?: string
  readonly if?: string
  readonly env: WorkflowEnv
  readonly continueOnError: boolean | string
  readonly timeoutMinutes?: number | string
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

export type RunDefaults = {
  readonly shell?: string
  readonly workingDirectory?: string
}

export type JobStrategy = {
  readonly matrix: YamlValue
  readonly failFast: YamlValue
  readonly maxParallel?: YamlValue
}

export type JobEnvironment = {
  readonly name: string
  readonly url?: string
}

export type Concurrency = {
  readonly group: string
  readonly cancelInProgress: YamlValue
}

export type PermissionLevel = 'read' | 'write' | 'none'

export type Permissions = 'read-all' | 'write-all' | Readonly<Record<string, PermissionLevel>>

export type WorkflowJob = {
  readonly id: string
  readonly name: string
  readonly explicitName: boolean
  readonly if?: string
  readonly runsOn: readonly string[]
  readonly needs: readonly string[]
  readonly env: WorkflowEnv
  readonly defaults: RunDefaults
  readonly outputs: WorkflowEnv
  readonly strategy?: JobStrategy
  readonly environment?: JobEnvironment
  readonly continueOnError: boolean | string
  readonly timeoutMinutes: number
  readonly permissions?: Permissions
  readonly concurrency?: Concurrency
  readonly container?: YamlValue
  readonly services?: Readonly<Record<string, YamlValue>>
  readonly steps: readonly WorkflowStep[]
}

export type BranchFilter = {
  readonly branches?: readonly string[]
  readonly branchesIgnore?: readonly string[]
  readonly tags?: readonly string[]
  readonly tagsIgnore?: readonly string[]
  readonly paths?: readonly string[]
  readonly pathsIgnore?: readonly string[]
}

export type DispatchInputType = 'string' | 'boolean' | 'number' | 'choice' | 'environment'

export type DispatchInput = {
  readonly description?: string
  readonly required: boolean
  readonly default?: string | number | boolean
  readonly type: DispatchInputType
  readonly options?: readonly string[]
}

export type WorkflowTrigger = BranchFilter & {
  readonly event: string
  readonly types?: readonly string[]
  readonly inputs?: Readonly<Record<string, DispatchInput>>
  readonly crons?: readonly string[]
}

export type Workflow = {
  readonly name?: string
  readonly triggers: readonly WorkflowTrigger[]
  readonly env: WorkflowEnv
  readonly defaults: RunDefaults
  readonly concurrency?: Concurrency
  readonly permissions?: Permissions
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

const WORKFLOW_KEYS = new Set(['name', 'on', 'env', 'defaults', 'concurrency', 'jobs', 'permissions'])

const JOB_KEYS = new Set(['name', 'if', 'runs-on', 'needs', 'env', 'defaults', 'outputs', 'strategy', 'environment', 'continue-on-error', 'timeout-minutes', 'steps', 'permissions', 'concurrency', 'container', 'services'])

const CONTAINER_KEYS = new Set(['image', 'credentials', 'env', 'ports', 'volumes', 'options'])

const STRATEGY_KEYS = new Set(['matrix', 'fail-fast', 'max-parallel'])

const INPUT_TYPES: ReadonlySet<string> = new Set(['string', 'boolean', 'number', 'choice', 'environment'])

const TRIGGER_FILTER_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  push: new Set(['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore']),
  pull_request: new Set(['branches', 'branches-ignore', 'types', 'paths', 'paths-ignore']),
  workflow_dispatch: new Set(['inputs']),
}

const PERMISSION_SCOPES: ReadonlySet<string> = new Set([
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'repository-projects',
  'security-events',
  'statuses',
])

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

  booleanish(value: YamlValue | undefined, path: string): boolean | string {
    if (value === undefined || value === null) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'string' && /\$\{\{[\s\S]*\}\}/.test(value)) return value
    this.fail(path, 'expected true, false or an expression')
    return false
  }

  minutes(value: YamlValue | undefined, path: string): number | string | undefined {
    if (typeof value === 'string' && /\$\{\{[\s\S]*\}\}/.test(value)) return value
    return this.positiveNumber(value, path)
  }

  defaults(value: YamlValue | undefined, path: string): RunDefaults {
    if (value === undefined || value === null) return {}
    if (!isMapping(value)) {
      this.fail(path, 'expected a mapping')
      return {}
    }
    this.unsupported(value, new Set(['run']), path)
    const run = value['run']
    if (run === undefined || run === null) return {}
    if (!isMapping(run)) {
      this.fail(`${path}.run`, 'expected a mapping')
      return {}
    }
    this.unsupported(run, new Set(['shell', 'working-directory']), `${path}.run`)
    return {
      ...optional('shell', this.scalarString(run['shell'], `${path}.run.shell`)),
      ...optional('workingDirectory', this.scalarString(run['working-directory'], `${path}.run.working-directory`)),
    }
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
    if (event === 'schedule') return { event, crons: parseSchedule(filter, c) }
    if (!isMapping(filter)) return { event }
    const path = `on.${event}`
    const allowed = TRIGGER_FILTER_KEYS[event]
    if (allowed) c.unsupported(filter, allowed, path)
    return {
      event,
      ...optional('branches', c.stringList(filter['branches'], `${path}.branches`)),
      ...optional('branchesIgnore', c.stringList(filter['branches-ignore'], `${path}.branches-ignore`)),
      ...optional('tags', c.stringList(filter['tags'], `${path}.tags`)),
      ...optional('tagsIgnore', c.stringList(filter['tags-ignore'], `${path}.tags-ignore`)),
      ...optional('paths', c.stringList(filter['paths'], `${path}.paths`)),
      ...optional('pathsIgnore', c.stringList(filter['paths-ignore'], `${path}.paths-ignore`)),
      ...optional('types', c.stringList(filter['types'], `${path}.types`)),
      ...optional('inputs', event === 'workflow_dispatch' ? parseInputs(filter['inputs'], `${path}.inputs`, c) : undefined),
    }
  })
}

const parseSchedule = (value: YamlValue | undefined, c: Collector): string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    c.fail('on.schedule', 'expected a list of { cron } entries')
    return []
  }
  return value.flatMap((entry, index) => {
    const cron = isMapping(entry) ? c.scalarString(entry['cron'], `on.schedule[${index}].cron`) : undefined
    if (cron === undefined) {
      c.fail(`on.schedule[${index}]`, 'expected a mapping with "cron"')
      return []
    }
    try {
      parseCron(cron)
    } catch (error) {
      c.fail(`on.schedule[${index}].cron`, (error as Error).message)
      return []
    }
    return [cron]
  })
}

const parseInputs = (value: YamlValue | undefined, path: string, c: Collector): Record<string, DispatchInput> | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isMapping(value)) {
    c.fail(path, 'expected a mapping')
    return undefined
  }
  const inputs: Record<string, DispatchInput> = {}
  for (const [name, spec] of Object.entries(value)) {
    const inputPath = `${path}.${name}`
    const definition = isMapping(spec) ? spec : {}
    if (spec !== null && !isMapping(spec)) c.fail(inputPath, 'expected a mapping')
    c.unsupported(definition, new Set(['description', 'required', 'default', 'type', 'options']), inputPath)
    const type = c.scalarString(definition['type'], `${inputPath}.type`) ?? 'string'
    if (!INPUT_TYPES.has(type)) c.fail(`${inputPath}.type`, 'must be string, boolean, number, choice or environment')
    const options = c.stringList(definition['options'], `${inputPath}.options`)
    if (type === 'choice' && (!options || options.length === 0)) c.fail(`${inputPath}.options`, 'a choice input needs options')
    const fallback = definition['default']
    inputs[name] = {
      ...optional('description', c.scalarString(definition['description'], `${inputPath}.description`)),
      required: definition['required'] === true,
      ...optional('default', typeof fallback === 'string' || typeof fallback === 'number' || typeof fallback === 'boolean' ? fallback : undefined),
      type: type as DispatchInputType,
      ...optional('options', options),
    }
  }
  return inputs
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
    continueOnError: c.booleanish(value['continue-on-error'], `${path}.continue-on-error`),
    ...optional('timeoutMinutes', c.minutes(value['timeout-minutes'], `${path}.timeout-minutes`)),
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
  const name = c.scalarString(value['name'], `${path}.name`)
  return {
    id,
    name: name ?? id,
    explicitName: name !== undefined,
    ...optional('if', c.condition(value['if'], `${path}.if`)),
    runsOn: parseRunsOn(value['runs-on'], `${path}.runs-on`, c),
    needs: c.stringList(value['needs'], `${path}.needs`) ?? [],
    env: c.env(value['env'], `${path}.env`),
    defaults: c.defaults(value['defaults'], `${path}.defaults`),
    outputs: c.env(value['outputs'], `${path}.outputs`),
    ...optional('strategy', parseStrategy(value['strategy'], `${path}.strategy`, c)),
    ...optional('environment', parseEnvironment(value['environment'], `${path}.environment`, c)),
    continueOnError: c.booleanish(value['continue-on-error'], `${path}.continue-on-error`),
    timeoutMinutes: c.positiveNumber(value['timeout-minutes'], `${path}.timeout-minutes`) ?? DEFAULT_TIMEOUT_MINUTES,
    ...optional('permissions', parsePermissions(value['permissions'], `${path}.permissions`, c)),
    ...optional('concurrency', parseConcurrency(value['concurrency'], `${path}.concurrency`, c)),
    ...optional('container', parseContainer(value['container'], `${path}.container`, c)),
    ...optional('services', parseServices(value['services'], `${path}.services`, c)),
    steps: steps.flatMap((step, index) => parseStep(step, `${path}.steps[${index}]`, c) ?? []),
  }
}

const parseContainer = (value: YamlValue | undefined, path: string, c: Collector): YamlValue | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (!isMapping(value)) {
    c.fail(path, 'expected an image or a mapping')
    return undefined
  }
  c.unsupported(value, CONTAINER_KEYS, path)
  if (value['image'] === undefined) c.fail(`${path}.image`, 'is required')
  return value
}

const parseServices = (value: YamlValue | undefined, path: string, c: Collector): Record<string, YamlValue> | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isMapping(value)) {
    c.fail(path, 'expected a mapping')
    return undefined
  }
  const services: Record<string, YamlValue> = {}
  for (const [name, service] of Object.entries(value)) {
    if (!JOB_ID.test(name)) c.fail(`${path}.${name}`, 'service names must start with a letter or "_" and contain only letters, digits, "-" and "_"')
    const parsed = parseContainer(service, `${path}.${name}`, c)
    if (parsed !== undefined) services[name] = parsed
  }
  return services
}

const isExpression = (value: YamlValue | undefined): boolean => typeof value === 'string' && /^\s*\$\{\{[\s\S]*\}\}\s*$/.test(value)

const parseStrategy = (value: YamlValue | undefined, path: string, c: Collector): JobStrategy | undefined => {
  if (value === undefined || value === null) return undefined
  if (!isMapping(value)) {
    c.fail(path, 'expected a mapping')
    return undefined
  }
  c.unsupported(value, STRATEGY_KEYS, path)
  const matrix = value['matrix']
  if (!isMapping(matrix) && !isExpression(matrix)) c.fail(`${path}.matrix`, 'expected a mapping or an expression')
  if (isMapping(matrix)) {
    for (const [key, vector] of Object.entries(matrix)) {
      if (!Array.isArray(vector) && !isExpression(vector)) c.fail(`${path}.matrix.${key}`, 'expected a list or an expression')
    }
  }
  const failFast = value['fail-fast'] ?? true
  if (typeof failFast !== 'boolean' && !isExpression(failFast)) c.fail(`${path}.fail-fast`, 'expected true, false or an expression')
  const maxParallel = value['max-parallel']
  if (maxParallel !== undefined && maxParallel !== null && !(typeof maxParallel === 'number' && maxParallel >= 1) && !isExpression(maxParallel)) {
    c.fail(`${path}.max-parallel`, 'expected a positive number or an expression')
  }
  return { matrix: matrix ?? null, failFast, ...optional('maxParallel', maxParallel ?? undefined) }
}

const parseEnvironment = (value: YamlValue | undefined, path: string, c: Collector): JobEnvironment | undefined => {
  if (value === undefined || value === null) return undefined
  if (isMapping(value)) {
    c.unsupported(value, new Set(['name', 'url']), path)
    const name = c.scalarString(value['name'], `${path}.name`)
    if (name === undefined) c.fail(`${path}.name`, 'is required')
    return { name: name ?? '', ...optional('url', c.scalarString(value['url'], `${path}.url`)) }
  }
  const name = c.scalarString(value, path)
  return name === undefined ? undefined : { name }
}

const parsePermissions = (value: YamlValue | undefined, path: string, c: Collector): Permissions | undefined => {
  if (value === undefined || value === null) return undefined
  if (value === 'read-all' || value === 'write-all') return value
  if (!isMapping(value)) {
    c.fail(path, 'expected read-all, write-all or a mapping of scopes')
    return undefined
  }
  const permissions: Record<string, PermissionLevel> = {}
  for (const [scope, level] of Object.entries(value)) {
    if (!PERMISSION_SCOPES.has(scope)) c.fail(`${path}.${scope}`, 'is not a known permission scope')
    else if (level !== 'read' && level !== 'write' && level !== 'none') c.fail(`${path}.${scope}`, 'expected read, write or none')
    else if (scope === 'id-token' && level === 'read') c.fail(`${path}.${scope}`, 'expected write or none')
    else permissions[scope] = level
  }
  return permissions
}

export const effectivePermissions = (workflow: Pick<Workflow, 'permissions'> | null | undefined, job: Pick<WorkflowJob, 'permissions'>): Permissions | undefined =>
  job.permissions ?? workflow?.permissions

export const grantsPermission = (permissions: Permissions | undefined, scope: string, level: 'read' | 'write'): boolean => {
  if (permissions === undefined) return false
  if (permissions === 'write-all') return true
  if (permissions === 'read-all') return level === 'read' && scope !== 'id-token'
  const granted = permissions[scope]
  return granted === 'write' || (granted === 'read' && level === 'read')
}

const parseConcurrency = (value: YamlValue | undefined, path: string, c: Collector): Concurrency | undefined => {
  if (value === undefined || value === null) return undefined
  if (isMapping(value)) {
    c.unsupported(value, new Set(['group', 'cancel-in-progress']), path)
    const group = c.scalarString(value['group'], `${path}.group`)
    if (group === undefined) c.fail(`${path}.group`, 'is required')
    const cancel = value['cancel-in-progress'] ?? false
    if (typeof cancel !== 'boolean' && !isExpression(cancel)) c.fail(`${path}.cancel-in-progress`, 'expected true, false or an expression')
    return { group: group ?? '', cancelInProgress: cancel }
  }
  const group = c.scalarString(value, path)
  return group === undefined ? undefined : { group, cancelInProgress: false }
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
    defaults: c.defaults(document['defaults'], 'defaults'),
    ...optional('concurrency', parseConcurrency(document['concurrency'], 'concurrency', c)),
    ...optional('permissions', parsePermissions(document['permissions'], 'permissions', c)),
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

export const hasPathFilter = (trigger: WorkflowTrigger): boolean => trigger.paths !== undefined || trigger.pathsIgnore !== undefined

export const matchesPaths = (trigger: WorkflowTrigger, changed: readonly string[] | null): boolean => {
  if (changed === null || !hasPathFilter(trigger)) return true
  if (trigger.pathsIgnore && !changed.some((path) => matchesFilters(path, undefined, trigger.pathsIgnore))) return false
  return !trigger.paths || changed.some((path) => matchesFilters(path, trigger.paths, undefined))
}

export const triggeredByPush = (workflow: Workflow, ref: string, changed: readonly string[] | null = null): boolean =>
  workflow.triggers.some((trigger) => {
    if (trigger.event !== 'push') return false
    if (!ref.startsWith('refs/tags/') && !matchesPaths(trigger, changed)) return false
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

export const DEFAULT_PULL_REQUEST_TYPES = ['opened', 'synchronize', 'reopened']

export const triggeredByPullRequest = (workflow: Workflow, baseBranch: string, action: string, changed: readonly string[] | null = null): boolean =>
  workflow.triggers.some(
    (trigger) =>
      trigger.event === 'pull_request' &&
      (trigger.types ?? DEFAULT_PULL_REQUEST_TYPES).includes(action) &&
      matchesFilters(baseBranch, trigger.branches, trigger.branchesIgnore) &&
      matchesPaths(trigger, changed),
  )

export const dispatchTrigger = (workflow: Workflow): WorkflowTrigger | undefined => workflow.triggers.find((trigger) => trigger.event === 'workflow_dispatch')

export const scheduleCrons = (workflow: Workflow): readonly string[] => workflow.triggers.flatMap((trigger) => (trigger.event === 'schedule' ? (trigger.crons ?? []) : []))

export class DispatchInputError extends Error {}

export const resolveDispatchInputs = (
  definitions: Readonly<Record<string, DispatchInput>>,
  given: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> => {
  const unknown = Object.keys(given).filter((name) => !(name in definitions))
  if (unknown.length > 0) throw new DispatchInputError(`unexpected inputs: ${unknown.join(', ')}`)
  const resolved: Record<string, string | number | boolean> = {}
  for (const [name, definition] of Object.entries(definitions)) {
    const raw = given[name] ?? definition.default
    if (raw === undefined || raw === '') {
      if (definition.required) throw new DispatchInputError(`input "${name}" is required`)
      resolved[name] = definition.type === 'boolean' ? false : ''
      continue
    }
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') throw new DispatchInputError(`input "${name}" must be a scalar`)
    if (definition.type === 'boolean') {
      if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') throw new DispatchInputError(`input "${name}" must be a boolean`)
      resolved[name] = raw === true || raw === 'true'
    } else if (definition.type === 'number') {
      const number = Number(raw)
      if (raw === '' || !Number.isFinite(number)) throw new DispatchInputError(`input "${name}" must be a number`)
      resolved[name] = number
    } else {
      const text = String(raw)
      if (definition.type === 'choice' && !(definition.options ?? []).includes(text)) throw new DispatchInputError(`input "${name}" must be one of ${(definition.options ?? []).join(', ')}`)
      resolved[name] = text
    }
  }
  return resolved
}

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
