import { base, signUpWithPasskey } from './support.ts'
import { expect, test } from '@playwright/test'

test('creates a repository from the navbar and shows how to push into it', async ({ page, context }, info) => {
  const login = `maker-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  await page.getByRole('link', { name: 'New repository' }).first().click()
  await expect(page.getByRole('heading', { name: 'New repository' })).toBeVisible()
  const form = page.getByRole('form', { name: 'Create a repository' })
  await expect(form.getByLabel('Owner')).toHaveValue(login)
  await form.getByLabel('Repository name').fill('notes')
  await form.getByRole('button', { name: 'Create repository' }).click()
  await expect(page).toHaveURL(`${base()}/${login}/notes`)
  await expect(page.getByRole('heading', { name: 'This repository is empty' })).toBeVisible()
  await expect(page.getByLabel('Clone over HTTPS').last()).toHaveValue(`${base()}/${login}/notes.git`)
  await expect(page.getByText('git push -u origin main')).toBeVisible()
})

test('imports a repository from a git server and follows its status', async ({ page, context }, info) => {
  test.setTimeout(120_000)
  const login = `importer-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  await page.getByRole('link', { name: 'New repository' }).first().click()
  const form = page.getByRole('form', { name: 'Import a repository' })
  await form.getByLabel('Clone URL').fill(process.env.UPSTREAM_URL!)
  await form.getByLabel('Access token (optional)').fill(process.env.UPSTREAM_TOKEN!)
  await expect(form.getByLabel('Owner')).toHaveValue(login)
  await form.getByLabel('Repository name').fill('copy')
  await form.getByRole('button', { name: 'Start import' }).click()
  await expect(page).toHaveURL(`${base()}/${login}/copy/import`)
  await expect(page.getByRole('heading', { name: `Import into ${login}/copy` })).toBeVisible()
  await expect(page.getByText(process.env.UPSTREAM_TOKEN!)).toHaveCount(0)
  await expect(page.getByRole('status')).toHaveText('Done', { timeout: 90_000 })
  await page.getByRole('link', { name: 'Open the repository' }).click()
  await expect(page).toHaveURL(`${base()}/${login}/copy`)
  await expect(page.getByRole('heading', { name: 'Upstream' })).toBeVisible()
  await expect(page.getByText('Add notes')).toBeVisible()
})
