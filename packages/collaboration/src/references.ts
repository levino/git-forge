export type IssueReference = {
  readonly owner: string | null
  readonly repo: string | null
  readonly number: number
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\1\2[`~]*[ \t]*(?=\n|$)|$)/gm
const INLINE_CODE = /(`+)[^`]*?\1/g

export const stripCode = (markdown: string): string => markdown.replace(FENCE, ' ').replace(INLINE_CODE, ' ')

const REFERENCE = /(^|[^\w/#&-])(?:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+))?#([1-9]\d{0,9})(?![\w-])/g

const CLOSING = /(^|[^\w-])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+))?#([1-9]\d{0,9})(?![\w-])/gi

const unique = (references: readonly IssueReference[]): IssueReference[] => {
  const seen = new Set<string>()
  return references.filter((reference) => {
    const key = `${reference.owner ?? ''}/${reference.repo ?? ''}#${reference.number}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const parseReferences = (markdown: string | null | undefined): IssueReference[] =>
  unique(
    [...stripCode(markdown ?? '').matchAll(REFERENCE)].map((match) => ({
      owner: match[2] ?? null,
      repo: match[3] ?? null,
      number: Number(match[4]),
    })),
  )

export const parseClosingReferences = (markdown: string | null | undefined): IssueReference[] =>
  unique(
    [...stripCode(markdown ?? '').matchAll(CLOSING)].map((match) => ({
      owner: match[3] ?? null,
      repo: match[4] ?? null,
      number: Number(match[5]),
    })),
  )

export const referencesRepository = (reference: IssueReference, repository: { readonly owner: string; readonly name: string }): boolean =>
  reference.owner === null ||
  (reference.owner.toLowerCase() === repository.owner.toLowerCase() && reference.repo?.toLowerCase() === repository.name.toLowerCase())

export const localNumbers = (references: readonly IssueReference[], repository: { readonly owner: string; readonly name: string }): number[] => [
  ...new Set(references.filter((reference) => referencesRepository(reference, repository)).map((reference) => reference.number)),
]
