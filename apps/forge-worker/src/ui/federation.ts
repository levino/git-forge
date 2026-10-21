import { AccountsError } from '@git-forge/accounts'
import { HttpError, type ForgeServices, type UiSession } from '../app.ts'
import { FederationFlowError } from '../federation-installations.ts'

export type FederationOutcome = { readonly kind: 'redirect'; readonly location: string } | { readonly kind: 'ok'; readonly message: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

const field = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

export const federationFailure = (error: unknown): FederationOutcome => {
  if (error instanceof FederationFlowError || error instanceof HttpError) return { kind: 'error', status: error.status, message: error.message }
  if (error instanceof AccountsError) return { kind: 'error', status: 400, message: error.message }
  throw error
}

const writeSession = async (forge: ForgeServices, request: Request): Promise<{ session: UiSession; form: FormData } | FederationOutcome> => {
  const session = await forge.verifySessionWrite(request)
  if (!session) return { kind: 'error', status: 403, message: 'The form expired. Reload the page and try again.' }
  return { session, form: await request.formData() }
}

export const handleConsentPost = async (forge: ForgeServices, request: Request, params: URLSearchParams): Promise<FederationOutcome> => {
  const written = await writeSession(forge, request)
  if ('kind' in written) return written
  const { session, form } = written
  try {
    const location = await forge.federation.consent(session.principal, forge.federation.authorizeRequest(params), {
      account: field(form, 'account'),
      selection: field(form, 'selection'),
      repositoryIds: form.getAll('repositories').map(String),
    })
    return { kind: 'redirect', location }
  } catch (error) {
    return federationFailure(error)
  }
}

export const handleForgesPost = async (forge: ForgeServices, request: Request): Promise<FederationOutcome> => {
  const written = await writeSession(forge, request)
  if ('kind' in written) return written
  try {
    await forge.federation.revoke(written.session.principal, field(written.form, 'id'))
    return { kind: 'ok', message: 'Installation revoked.' }
  } catch (error) {
    return federationFailure(error)
  }
}

export const federationMirrorAction = async (forge: ForgeServices, session: UiSession, form: FormData): Promise<FederationOutcome> => {
  try {
    if (form.get('action') === 'federation') return { kind: 'redirect', location: await forge.federation.start(session.principal, session.sessionId, field(form, 'upstream')) }
    const installation = field(form, 'installation')
    const { connection } = await forge.federation.remote(session.principal, installation)
    const [upstreamOwner = '', upstreamName = ''] = field(form, 'repository').split('/')
    const owner = field(form, 'owner')
    const name = field(form, 'name') || upstreamName
    await forge.repositories.create(session.principal, { owner, name, visibility: 'private' })
    await forge.settings.addMirror(session.principal, { owner, name }, { url: `${connection.upstream}/${upstreamOwner}/${upstreamName}.git`, auth: 'installation', installation })
    return { kind: 'redirect', location: `/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/settings` }
  } catch (error) {
    return federationFailure(error)
  }
}
