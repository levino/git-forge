import { expect, test } from '@playwright/test'
import { base, signUpWithPasskey } from './support.ts'

test('proposes an edit through a fork and reacts to the pull request', async ({ page, context }, info) => {
  await signUpWithPasskey(page, context, `editor-${info.project.name}`)
  await page.goto(`${base()}/octo/gallery/blob/main/README.md`)
  await page.getByRole('link', { name: 'Edit', exact: true }).click()
  await expect(page.getByText('Your change is committed to a new branch of your fork')).toBeVisible()
  await page.getByLabel('Content').fill(`# Gallery\n\nEdited on ${info.project.name}.\n`)
  await page.getByLabel('Commit message').fill(`Edit the README (${info.project.name})`)
  await page.getByRole('button', { name: 'Propose changes' }).click()
  await expect(page).toHaveURL(/\/octo\/gallery\/pull\/\d+$/)
  await expect(page.getByRole('heading', { name: new RegExp(`Edit the README \\(${info.project.name}\\)`) })).toBeVisible()
  await expect(page.getByText(`editor-${info.project.name}:patch-1`)).toBeVisible()
  await page.getByLabel('Add reaction').first().click()
  await page.getByRole('button', { name: 'React with hooray' }).first().click()
  await expect(page.getByRole('button', { name: 'hooray: 1' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('link', { name: 'Files changed' }).click()
  await expect(page.getByText(`Edited on ${info.project.name}.`)).toBeVisible()
})
