import { expect, test } from '@playwright/test'
import { base, signUpWithPasskey } from './support.ts'

test('comments on a diff line of a pull request and opens an issue', async ({ page, context }, info) => {
  await signUpWithPasskey(page, context, `reviewer-${info.project.name}`)
  await page.goto(`${base()}/octo/gallery/pulls`)
  await page.getByRole('link', { name: 'Say goodbye' }).click()
  await expect(page.getByText('This branch can be merged')).toBeVisible()
  await page.getByRole('link', { name: 'Files changed' }).click()
  await page.getByRole('button', { name: 'Comment on line 2 of src/app.ts' }).click()
  const form = page.getByRole('form', { name: 'Comment on line' })
  await form.getByRole('textbox', { name: 'Comment' }).fill(`Needs a test (${info.project.name})`)
  await form.getByRole('button', { name: 'Add comment' }).click()
  await expect(page).toHaveURL(/\/files#discussion-\d+$/)
  await expect(page.getByText(`Needs a test (${info.project.name})`)).toBeVisible()

  await page.goto(`${base()}/octo/gallery/issues/new`)
  await page.getByLabel('Title').fill(`Typo on the home page (${info.project.name})`)
  await page.getByLabel('Description').fill('It says **Helo**.')
  await page.getByRole('button', { name: 'Create issue' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`Typo on the home page \\(${info.project.name}\\)`) })).toBeVisible()
  await expect(page.locator('article strong')).toHaveText('Helo')
})
