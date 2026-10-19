import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from '@playwright/test'
import { gitEnv, tempDir } from '../e2e/history.ts'
import { base, signUpWithPasskey } from './support.ts'

const LFS = ['filter.lfs.process=git-lfs filter-process', 'filter.lfs.smudge=git-lfs smudge -- %f', 'filter.lfs.clean=git-lfs clean -- %f', 'filter.lfs.required=true']

test('uploads an LFS-tracked file larger than the form limit straight to Git LFS', async ({ page, context }, info) => {
  const login = `uploader-${info.project.name}`
  await signUpWithPasskey(page, context, login)
  await page.goto(`${base()}/octo/gallery/tree/main/images`)
  await page.getByRole('link', { name: 'Upload files' }).click()
  const picture = Buffer.alloc(12 * 1024 * 1024, info.project.name)
  await page.locator('input[name=files]').setInputFiles({ name: `big-${info.project.name}.png`, mimeType: 'image/png', buffer: picture })
  await page.getByLabel('Commit message').fill(`Add a big picture (${info.project.name})`)
  await page.getByRole('button', { name: 'Propose changes' }).click()
  await expect(page).toHaveURL(/\/octo\/gallery\/pull\/\d+$/, { timeout: 20_000 })
  await expect(page.getByText(`${login}:patch-1`)).toBeVisible()
  const dir = join(tempDir(), 'clone')
  await promisify(execFile)('git', [...LFS.flatMap((entry) => ['-c', entry]), 'clone', '-q', '-b', 'patch-1', `${process.env.FORGE_URL}/${login}/gallery.git`, dir], { env: { ...process.env, ...gitEnv } })
  expect(readFileSync(join(dir, `images/big-${info.project.name}.png`)).equals(picture)).toBe(true)
})
