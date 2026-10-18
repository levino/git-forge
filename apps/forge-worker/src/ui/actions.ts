import type { JobRow, RunRow } from '@git-forge/actions'

export type RunState = { readonly label: string; readonly badge: string; readonly done: boolean }

const conclusionState = (conclusion: string | null): RunState => {
  if (conclusion === 'success') return { label: 'Success', badge: 'badge-success', done: true }
  if (conclusion === 'skipped' || conclusion === 'neutral') return { label: conclusion === 'skipped' ? 'Skipped' : 'Neutral', badge: 'badge-ghost', done: true }
  if (conclusion === 'cancelled') return { label: 'Cancelled', badge: 'badge-neutral', done: true }
  return { label: conclusion ? conclusion.replace(/_/g, ' ') : 'Failure', badge: 'badge-error', done: true }
}

export const runState = (run: RunRow): RunState => {
  if (run.cancelled_at !== null && run.completed_at === null) return { label: 'Cancelling', badge: 'badge-warning', done: false }
  if (run.completed_at !== null) return conclusionState(run.conclusion)
  return { label: 'In progress', badge: 'badge-warning', done: false }
}

export const jobState = (job: JobRow): RunState => {
  if (job.status === 'completed') return conclusionState(job.conclusion)
  if (job.approval === 'waiting') return { label: 'Waiting for approval', badge: 'badge-info', done: false }
  if (job.status === 'in_progress') return { label: 'In progress', badge: 'badge-warning', done: false }
  return { label: 'Queued', badge: 'badge-ghost', done: false }
}

export const branchOf = (ref: string): string => ref.replace(/^refs\/(heads|tags)\//, '')

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

export const MAX_LOG_BYTES = 2 * 1024 * 1024

export const logText = (parts: readonly Uint8Array[]): { readonly text: string; readonly truncated: boolean } => {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const bytes = new Uint8Array(Math.min(size, MAX_LOG_BYTES))
  let offset = Math.max(0, size - MAX_LOG_BYTES)
  let written = 0
  for (const part of parts) {
    if (offset >= part.length) {
      offset -= part.length
      continue
    }
    const slice = part.subarray(offset)
    bytes.set(slice.subarray(0, bytes.length - written), written)
    written += Math.min(slice.length, bytes.length - written)
    offset = 0
  }
  return { text: new TextDecoder().decode(bytes).replace(ANSI, '').replace(/\r\n?/g, '\n'), truncated: size > MAX_LOG_BYTES }
}

export const durationText = (from: number | null, to: number | null): string => {
  if (from === null) return ''
  const seconds = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
