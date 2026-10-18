export type Refspec = {
  readonly force: boolean
  readonly src: string
  readonly dst: string | null
}

export const parseRefspec = (text: string): Refspec => {
  const force = text.startsWith('+')
  const body = force ? text.slice(1) : text
  const colon = body.indexOf(':')
  const src = colon === -1 ? body : body.slice(0, colon)
  const dst = colon === -1 ? null : body.slice(colon + 1)
  if (src === '') throw new Error(`deleting refs is not supported by git forge push: ${text}`)
  if (dst === '') throw new Error(`invalid refspec: ${text}`)
  return { force, src, dst }
}

export const qualifyDestination = (dst: string, sourceFullName: string | null, remoteRefs: ReadonlyMap<string, string>): string => {
  if (dst.startsWith('refs/')) return dst
  for (const candidate of [`refs/heads/${dst}`, `refs/tags/${dst}`]) if (remoteRefs.has(candidate)) return candidate
  return sourceFullName?.startsWith('refs/tags/') ? `refs/tags/${dst}` : `refs/heads/${dst}`
}

export const CHUNK_PREFIX = 'refs/forge-chunk/'

export const chunkRefPrefix = (dst: string): string => `${CHUNK_PREFIX}${dst.slice('refs/'.length)}/`
