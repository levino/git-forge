import { OrganizationError } from '@git-forge/accounts'
import type { ForgeServices, UiSession } from '../app.ts'

export type OrganizationOutcome = { readonly kind: 'ok'; readonly message: string } | { readonly kind: 'redirect'; readonly location: string } | { readonly kind: 'error'; readonly status: number; readonly message: string }

const text = (form: FormData, name: string): string => String(form.get(name) ?? '').trim()

export const organizationAction = async (forge: ForgeServices, session: UiSession, org: string, form: FormData): Promise<OrganizationOutcome> => {
  const principal = session.principal
  const operations = forge.organizations
  try {
    switch (text(form, 'action')) {
      case 'create': {
        const created = await operations.create(principal, text(form, 'login'))
        return { kind: 'redirect', location: `/orgs/${encodeURIComponent(created.login)}` }
      }
      case 'member':
        await operations.setMember(principal, org, text(form, 'login'), text(form, 'role'))
        return { kind: 'ok', message: `${text(form, 'login')} is now ${text(form, 'role') === 'owner' ? 'an owner' : 'a member'}.` }
      case 'remove-member':
        await operations.removeMember(principal, org, text(form, 'login'))
        return { kind: 'ok', message: `${text(form, 'login')} removed.` }
      case 'team':
        await operations.createTeam(principal, org, text(form, 'slug'), text(form, 'name'))
        return { kind: 'redirect', location: `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(text(form, 'slug'))}` }
      case 'team-member':
        await operations.setTeamMember(principal, org, text(form, 'team'), text(form, 'login'), text(form, 'role'))
        return { kind: 'ok', message: `${text(form, 'login')} added to the team.` }
      case 'remove-team-member':
        await operations.removeTeamMember(principal, org, text(form, 'team'), text(form, 'login'))
        return { kind: 'ok', message: `${text(form, 'login')} removed from the team.` }
      case 'team-repository':
        await operations.setTeamRepository(principal, org, text(form, 'team'), text(form, 'repository'), text(form, 'role'))
        return { kind: 'ok', message: `Access to ${text(form, 'repository')} saved.` }
      case 'remove-team-repository':
        await operations.removeTeamRepository(principal, org, text(form, 'team'), text(form, 'repository'))
        return { kind: 'ok', message: `${text(form, 'repository')} removed from the team.` }
      default:
        return { kind: 'error', status: 400, message: 'Unknown action.' }
    }
  } catch (error) {
    if (error instanceof OrganizationError) return { kind: 'error', status: error.status, message: error.message }
    throw error
  }
}

export const handleOrganizationPost = async (forge: ForgeServices, request: Request, org: string): Promise<OrganizationOutcome> => {
  const session = await forge.verifySessionWrite(request)
  if (!session) return { kind: 'error', status: 403, message: 'The form expired or you are not signed in. Reload the page and try again.' }
  return organizationAction(forge, session, org, await request.formData())
}
