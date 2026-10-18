import type { ExpressionValue, MatrixCombination, RunDefaults, Workflow, WorkflowEnv, WorkflowJob } from '@git-forge/core'
import type { NeedResult, RunContext, StrategyContext } from './job-message.ts'
import type { JobRow, RunRow } from './store.ts'

export type RunInputs = Readonly<Record<string, string | number | boolean>>

export type RunDefinition = {
  readonly workflow: Workflow
  readonly inputs: RunInputs
  readonly payload: Readonly<Record<string, ExpressionValue>>
}

export type JobDefinition = {
  readonly job: WorkflowJob
  readonly workflowEnv: WorkflowEnv
  readonly workflowDefaults?: RunDefaults
  readonly matrix?: MatrixCombination | null
  readonly strategy?: StrategyContext | null
  readonly needs?: Readonly<Record<string, NeedResult>>
  readonly continueOnError?: boolean
  readonly error?: string
}

export const runDefinitionOf = (run: RunRow): RunDefinition | null => (run.definition ? (JSON.parse(run.definition) as RunDefinition) : null)

export const jobDefinitionOf = (job: JobRow): JobDefinition => JSON.parse(job.definition) as JobDefinition

export const jobOutputsOf = (job: JobRow): Record<string, string> => (job.outputs ? (JSON.parse(job.outputs) as Record<string, string>) : {})

export const runContextOf = (run: RunRow, definition: RunDefinition | null, job?: JobDefinition): RunContext => ({
  id: run.id,
  owner: run.owner,
  repo: run.repo,
  workflowName: run.workflow_name,
  workflowPath: run.workflow_path,
  workflowEnv: job?.workflowEnv ?? definition?.workflow.env ?? {},
  ...(job?.workflowDefaults ? { workflowDefaults: job.workflowDefaults } : definition ? { workflowDefaults: definition.workflow.defaults } : {}),
  event: run.event,
  ref: run.ref,
  sha: run.sha,
  actor: run.actor,
  attempt: run.attempt,
  ...(definition ? { payload: definition.payload, inputs: definition.inputs } : {}),
})
