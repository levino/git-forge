import { SANDBOX_HEADERS } from '@git-forge/core'
import type { APIRoute } from 'astro'
import { jobState, logText } from '../../../../../../../../ui/actions.ts'
import { parseNumber } from '../../../../../../../../ui/collaboration.ts'
import { openRepository } from '../../../../../../../../ui/repository.ts'

export const GET: APIRoute = async ({ params, locals }) => {
  const repo = await openRepository(locals.forge, locals.principal, params.owner!, params.repo!)
  const runId = parseNumber(params.id)
  const found = repo.kind === 'ok' && runId !== null && params.job ? await locals.forge.actions.log(repo.name, runId, params.job) : null
  if (!found) return new Response('not found\n', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  return new Response(logText(found.log).text, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SANDBOX_HEADERS,
      'X-Job-Done': jobState(found.job).done ? '1' : '0',
    },
  })
}
