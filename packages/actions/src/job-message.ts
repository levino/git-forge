import type { RunStep, UsesStep, WorkflowEnv, WorkflowJob, WorkflowStep } from '@git-forge/core'
import { contextDictionary, type ContextData, expressionToken, mappingToken, stepCondition, type TemplateToken } from './template.ts'

export type RunContext = {
  readonly id: number
  readonly owner: string
  readonly repo: string
  readonly workflowName: string
  readonly workflowPath: string
  readonly workflowEnv: WorkflowEnv
  readonly event: string
  readonly ref: string
  readonly sha: string
  readonly actor: string
}

export type JobMessageInput = {
  readonly requestId: number
  readonly jobId: string
  readonly planId: string
  readonly timelineId: string
  readonly stepIds: readonly string[]
  readonly job: WorkflowJob
  readonly run: RunContext
  readonly serverUrl: string
  readonly serviceUrl: string
  readonly runtimeToken: string
  readonly githubToken: string
  readonly secrets: Readonly<Record<string, string>>
}

export const PLAN_TYPE = 'actions'

export const JOB_REQUEST_MESSAGE_TYPE = 'PipelineAgentJobRequest'

const envToken = (env: WorkflowEnv): TemplateToken =>
  mappingToken(Object.fromEntries(Object.entries(env).map(([key, value]) => [key, expressionToken(value)])))

const parseUses = (uses: string): Record<string, string> => {
  if (uses.startsWith('docker://')) return { type: 'containerRegistry', image: uses.slice('docker://'.length) }
  if (uses.startsWith('./') || uses.startsWith('.\\')) return { type: 'repository', repositoryType: 'self', path: uses }
  const at = uses.lastIndexOf('@')
  const target = at === -1 ? uses : uses.slice(0, at)
  const [owner, name, ...path] = target.split('/')
  return { type: 'repository', repositoryType: 'GitHub', name: `${owner}/${name}`, ref: at === -1 ? '' : uses.slice(at + 1), path: path.join('/') }
}

const contextName = (step: WorkflowStep, used: Set<string>): string => {
  if (step.id) return step.id
  const base = step.kind === 'run' ? '__run' : `__${step.uses.replace(/@.*$/, '').replace(/[^A-Za-z0-9]+/g, '_')}`
  let name = base
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`
  used.add(name)
  return name
}

const displayName = (step: WorkflowStep): TemplateToken => {
  if (step.name) return expressionToken(step.name)
  if (step.kind === 'uses') return `Run ${step.uses}`
  return `Run ${step.run.trim().split('\n')[0]}`
}

const inputs = (step: WorkflowStep): TemplateToken => {
  if (step.kind === 'uses') return envToken((step as UsesStep).with)
  const run = step as RunStep
  return mappingToken({
    script: expressionToken(run.run),
    ...(run.shell ? { shell: expressionToken(run.shell) } : {}),
    ...(run.workingDirectory ? { workingDirectory: expressionToken(run.workingDirectory) } : {}),
  })
}

const buildStep = (step: WorkflowStep, id: string, used: Set<string>) => {
  const name = contextName(step, used)
  return {
    type: 'action',
    id,
    name,
    contextName: name,
    displayNameToken: displayName(step),
    reference: step.kind === 'run' ? { type: 'script' } : parseUses(step.uses),
    inputs: inputs(step),
    ...(Object.keys(step.env).length > 0 ? { environment: envToken(step.env) } : {}),
    condition: stepCondition(step.if),
    ...(step.continueOnError ? { continueOnError: true } : {}),
    ...(step.timeoutMinutes ? { timeoutInMinutes: step.timeoutMinutes } : {}),
  }
}

const githubContext = (input: JobMessageInput): ContextData => {
  const { run, serverUrl } = input
  const repository = `${run.owner}/${run.repo}`
  const refName = run.ref.replace(/^refs\/(heads|tags)\//, '')
  return contextDictionary({
    server_url: serverUrl,
    api_url: `${serverUrl}/api/v3`,
    graphql_url: `${serverUrl}/api/graphql`,
    workflow: run.workflowName,
    workflow_ref: `${repository}/${run.workflowPath}@${run.ref}`,
    workflow_sha: run.sha,
    repository,
    repository_owner: run.owner,
    sha: run.sha,
    ref: run.ref,
    ref_name: refName,
    ref_type: run.ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    ref_protected: false,
    run_id: String(run.id),
    run_number: String(run.id),
    run_attempt: '1',
    actor: run.actor,
    triggering_actor: run.actor,
    event_name: run.event,
    job: input.job.id,
    retention_days: '90',
    event: contextDictionary({
      ref: run.ref,
      after: run.sha,
      repository: contextDictionary({ full_name: repository, name: run.repo, owner: contextDictionary({ login: run.owner, name: run.owner }) }),
    }),
  })
}

const secret = (value: string) => ({ value, isSecret: true })

export const buildJobMessage = (input: JobMessageInput) => {
  const used = new Set<string>()
  const steps = input.job.steps.map((step, index) => {
    const id = input.stepIds[index]
    if (!id) throw new Error(`missing step id for step ${index}`)
    return buildStep(step, id, used)
  })
  return {
    messageType: JOB_REQUEST_MESSAGE_TYPE,
    plan: {
      scopeIdentifier: input.planId,
      planType: PLAN_TYPE,
      planGroup: PLAN_TYPE,
      planId: input.planId,
      version: 12,
      owner: { id: input.run.id, name: input.run.workflowName },
    },
    timeline: { id: input.timelineId, changeId: 1 },
    jobId: input.jobId,
    jobDisplayName: input.job.name,
    jobName: input.job.id,
    requestId: input.requestId,
    lockedUntil: '0001-01-01T00:00:00',
    resources: {
      endpoints: [
        {
          name: 'SystemVssConnection',
          url: input.serviceUrl,
          authorization: { scheme: 'OAuth', parameters: { AccessToken: input.runtimeToken } },
          data: {},
          isShared: false,
          isReady: true,
        },
      ],
    },
    contextData: {
      github: githubContext(input),
      inputs: contextDictionary({}),
      vars: contextDictionary({}),
      needs: contextDictionary({}),
      matrix: null,
      strategy: null,
    },
    workspace: {},
    mask: [],
    environmentVariables: [envToken(input.run.workflowEnv), envToken(input.job.env)].filter((token) => typeof token === 'object' && token !== null && 'map' in token),
    defaults: [],
    variables: {
      'system.github.token': secret(input.githubToken),
      github_token: secret(input.githubToken),
      'system.github.job': { value: input.job.id },
      'system.runner.lowdiskspacethreshold': { value: '100' },
      ...Object.fromEntries(Object.entries(input.secrets).map(([name, value]) => [name, secret(value)])),
    },
    steps,
    fileTable: [input.run.workflowPath],
  }
}

export type JobMessage = ReturnType<typeof buildJobMessage>
