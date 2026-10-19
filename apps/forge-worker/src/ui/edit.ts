import { commitChanges, editPlan, type EditPlan, type FileInput, invalid, type Scope, uploadTarget } from '@git-forge/collaboration'
import { MAX_WEB_FILE_BYTES, readBlobContent, resolveRefAndPath, resolveTarget } from '@git-forge/core'
import { field } from './collaboration.ts'
import { blobUrl, type OpenRepository, repoUrl, treeUrl } from './repository.ts'

export const EDIT_MODES = ['edit', 'new', 'upload', 'delete'] as const

export type EditMode = (typeof EDIT_MODES)[number]

export type EditView = {
  readonly mode: EditMode
  readonly branch: string
  readonly path: readonly string[]
  readonly sha: string | null
  readonly text: string | null
  readonly crlf: boolean
  readonly plan: EditPlan | null
  readonly suggestedBranch: string
}

export const MAX_FORM_BYTES = MAX_WEB_FILE_BYTES + 256 * 1024

export const oversizedForm = (request: Request): string | null => {
  const length = request.headers.get('Content-Length')
  if (length === null || !/^\d+$/.test(length)) return 'The upload has no Content-Length.'
  return Number(length) > MAX_FORM_BYTES ? `Uploads of files that are not tracked by Git LFS are limited to ${MAX_WEB_FILE_BYTES / 1024 / 1024} MiB per commit; push larger files with git.` : null
}

export const editMode = (value: string | null): EditMode => (EDIT_MODES as readonly string[]).includes(value ?? '') ? (value as EditMode) : 'edit'

export const editUrl = (repo: OpenRepository, mode: EditMode, branch: string, path: readonly string[]): string =>
  `${repoUrl(repo.name, 'edit', ...[...branch.split('/'), ...path].filter((segment) => segment !== '').map(encodeURIComponent))}${mode === 'edit' ? '' : `?mode=${mode}`}`

const headBranch = (repo: OpenRepository): string => repo.refs.head.replace(/^refs\/heads\//, '')

export const loadEditView = async (repo: OpenRepository, scope: Scope, segments: readonly string[], mode: EditMode, login: string): Promise<EditView | null> => {
  const empty = repo.branches.length === 0
  if (empty && mode !== 'new') return null
  const target = empty ? null : await resolveRefAndPath(repo.odb, repo.refs, segments)
  if (!empty && (!target || !repo.branches.some((branch) => branch.name === target.ref))) return null
  const branch = target?.ref ?? headBranch(repo)
  const path = target?.path ?? []
  const resolved = target ? await resolveTarget(repo.odb, target.commit, path) : null
  const isFile = mode === 'edit' || mode === 'delete'
  if (target && (!resolved || (resolved.kind === 'blob') !== isFile)) return null
  const content = resolved?.kind === 'blob' ? await readBlobContent(repo.odb, resolved.entry) : null
  if (mode === 'edit' && content?.kind !== 'text') return null
  const text = content?.kind === 'text' ? content.text : null
  const taken = new Set(repo.branches.map((entry) => entry.name))
  let n = 1
  while (taken.has(`${login}-patch-${n}`)) n++
  return {
    mode,
    branch,
    path,
    sha: resolved?.kind === 'blob' ? resolved.entry.id : null,
    text,
    crlf: text?.includes('\r\n') ?? false,
    plan: await editPlan(scope, branch),
    suggestedBranch: `${login}-patch-${n}`,
  }
}

const textOf = (form: FormData, crlf: boolean): string => {
  const text = field(form, 'content').replace(/\r\n/g, '\n')
  return crlf ? text.replace(/\n/g, '\r\n') : text
}

const filesOf = (view: EditView, form: FormData): FileInput[] => {
  const current = view.path.join('/')
  const encoder = new TextEncoder()
  const sha = field(form, 'sha') || view.sha
  if (view.mode === 'delete') return [{ path: current, content: null, sha }]
  if (view.mode === 'upload') {
    const files = form.getAll('files').filter((file): file is File => typeof file !== 'string' && file.name !== '')
    const pointers = form.getAll('lfs').map((value) => String(value).split(' '))
    if (files.length + pointers.length === 0) throw invalid('Choose at least one file to upload')
    const at = (name: string) => [current, name].filter(Boolean).join('/')
    return [
      ...files.map((file) => ({ path: at(file.name), content: file })),
      ...pointers.map(([oid = '', size = '', ...name]) => ({ path: at(name.join(' ')), content: { oid, size: Number(size) } })),
    ]
  }
  const path = field(form, 'path').trim()
  if (path === '') throw invalid('A file name is required')
  const content = encoder.encode(textOf(form, view.crlf))
  if (view.mode === 'new') return [{ path, content, sha: null }]
  return path === current ? [{ path, content, sha }] : [{ path: current, content: null, sha }, { path, content, sha: null }]
}

export const prepareUpload = async (scope: Scope, view: EditView, form: FormData): Promise<{ readonly repository: string; readonly lfs: readonly string[] }> => {
  const names = form.getAll('name').map(String)
  const target = await uploadTarget(scope, view.branch, names.map((name) => [...view.path, name].join('/')))
  const tracked = new Set(target.lfs)
  return { repository: `${target.repository.owner}/${target.repository.name}`, lfs: names.filter((name) => tracked.has([...view.path, name].join('/'))) }
}

export const defaultMessage = (view: EditView): string => {
  const name = view.path[view.path.length - 1] ?? ''
  return view.mode === 'edit' ? `Update ${name}` : view.mode === 'delete' ? `Delete ${name}` : view.mode === 'upload' ? 'Add files via upload' : 'Create new file'
}

export const submitEdit = async (scope: Scope, view: EditView, form: FormData): Promise<string> => {
  if (!view.plan) throw invalid('You cannot change this repository')
  const files = filesOf(view, form)
  const subject = field(form, 'message').trim() || (view.mode === 'new' ? `Create ${files[0]!.path}` : defaultMessage(view))
  const description = field(form, 'description').trim()
  const message = description === '' ? subject : `${subject}\n\n${description}`
  const branched = view.plan.mode === 'branch' || (view.plan.mode === 'direct' && field(form, 'target') === 'branch')
  const outcome = await commitChanges(scope, {
    branch: view.branch,
    message,
    files,
    propose: true,
    ...(branched ? { newBranch: field(form, 'branch').trim(), pull: view.plan.mode === 'branch' || field(form, 'pull') === '1' ? { title: subject, body: description } : null } : {}),
    ...(view.plan.mode === 'fork' ? { pull: { title: subject, body: description } } : {}),
  })
  if (outcome.pull) return repoUrl(scope.repo, 'pull', String(outcome.pull.number))
  const last = files[files.length - 1]!
  return view.mode === 'edit' || view.mode === 'new' ? blobUrl(outcome.repository, outcome.branch, last.path.split('/')) : treeUrl(outcome.repository, outcome.branch, view.mode === 'delete' ? view.path.slice(0, -1) : view.path)
}
