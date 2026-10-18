import { expect, test } from '@playwright/test'
import { api, base, signUpWithPasskey } from './support.ts'

test('creates an organization with a team and lists the sessions of the account', async ({ page, context }, info) => {
  const login = `founder-${info.project.name}`
  const org = `guild-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  await page.goto(`${base()}/organizations/new`)
  await page.getByLabel('Organization name').fill(org)
  await page.getByRole('button', { name: 'Create organization' }).click()
  await expect(page).toHaveURL(`${base()}/orgs/${org}`)
  await expect(page.getByRole('link', { name: login, exact: true }).first()).toBeVisible()
  const team = page.getByRole('form', { name: 'New team' })
  await team.getByLabel('Slug').fill('core')
  await team.getByLabel('Name').fill('Core team')
  await team.getByRole('button', { name: 'Create team' }).click()
  await expect(page).toHaveURL(`${base()}/orgs/${org}/teams/core`)
  await expect(page.getByRole('heading', { name: /Core team/ })).toBeVisible()
  const member = page.getByRole('form', { name: 'Add a team member' })
  await member.getByLabel('User').fill(login)
  await member.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('status')).toHaveText(`${login} added to the team.`)

  await page.goto(`${base()}/settings`)
  const sessions = page.getByRole('region', { name: 'Sessions' })
  await expect(sessions.getByText('this browser')).toBeVisible()
})

test('changes visibility, collaborators and branch protection of a repository', async ({ page, context }, info) => {
  const login = `maintainer-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  expect((await api('POST', '/api/repos', { owner: login, name: 'project' })).status).toBe(201)
  await page.goto(`${base()}/${login}/project/settings`)
  await page.getByRole('combobox', { name: 'Visibility' }).selectOption('public')
  await page.getByRole('region', { name: 'Visibility' }).getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('status')).toHaveText('Visibility changed.')
  const collaborator = page.getByRole('form', { name: 'Add a collaborator' })
  await collaborator.getByLabel('User').fill('octo')
  await collaborator.getByLabel('Role').selectOption('triage')
  await collaborator.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByRole('status')).toHaveText('Access for octo saved.')
  await expect(page.getByLabel('Role of octo')).toHaveValue('triage')
  const protect = page.getByRole('form', { name: 'Protect a branch' })
  await protect.getByLabel('Branch name pattern').fill('main')
  await protect.getByLabel('Require reviews').check()
  await protect.getByRole('button', { name: 'Add rule' }).click()
  await expect(page.getByRole('status')).toHaveText('Protection for main saved.')
  await expect(page.getByText('1 approvals')).toBeVisible()
})

test('cancels a workflow run and re-runs it', async ({ page, context }, info) => {
  const login = `operator-${info.project.name}`
  const repo = `pipeline-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  expect((await api('PUT', `/api/repos/octo/${repo}/collaborators/${login}`, { role: 'write' })).status).toBe(200)
  await page.goto(`${base()}/octo/${repo}/actions`)
  await expect(page.getByRole('navigation', { name: 'Workflows' }).getByRole('link', { name: 'Build' })).toBeVisible()
  await page.getByRole('list', { name: 'Workflow runs' }).getByRole('link', { name: 'Build' }).click()
  await expect(page.getByRole('list', { name: 'Jobs' }).getByText('Queued')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel run' }).click()
  await expect(page.getByRole('list', { name: 'Jobs' }).getByText('Cancelled')).toBeVisible()
  await page.getByRole('button', { name: 'Re-run all jobs' }).click()
  await expect(page.getByText('Attempt 2')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Jobs' }).getByText('Queued')).toBeVisible()
  await page.getByRole('list', { name: 'Jobs' }).getByRole('link', { name: 'test' }).click()
  await expect(page.getByRole('heading', { name: 'test', exact: true })).toBeVisible()
})

test('lets the instance admin trust an instance and see the mirrors', async ({ page, context }, info) => {
  const issuer = `https://peer-${info.project.name}.example`
  await signUpWithPasskey(page, context, 'octo', true)
  await page.getByLabel('Account menu (octo)').click()
  await page.getByRole('link', { name: 'Instance administration' }).click()
  await expect(page).toHaveURL(`${base()}/-/admin`)
  await expect(page.getByRole('region', { name: 'Admins' }).getByRole('link', { name: 'octo', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'octo/copy' })).toBeVisible()
  await expect(page.getByText('Not synced yet')).toBeVisible()
  const trust = page.getByRole('form', { name: 'Trust an instance' })
  await trust.getByLabel('Issuer').fill(issuer)
  await trust.getByRole('button', { name: 'Trust' }).click()
  await expect(page.getByRole('status')).toHaveText(`${issuer} is now trusted.`)
  await page.getByRole('button', { name: `Stop trusting ${issuer}` }).click()
  await expect(page.getByRole('status')).toHaveText(`${issuer} is no longer trusted.`)
  await expect(page.getByRole('button', { name: `Stop trusting ${issuer}` })).toHaveCount(0)
})
