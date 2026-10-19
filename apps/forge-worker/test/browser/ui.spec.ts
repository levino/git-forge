import { expect, type Page, test } from '@playwright/test'

const url = (path: string): string => `${process.env.FORGE_URL}${path}`

const noHorizontalScroll = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
}

test('walks from the home page to a highlighted file and its history', async ({ page }) => {
  await page.goto(url('/'))
  await expect(page.getByRole('heading', { name: 'Public repositories' })).toBeVisible()
  await page.getByRole('link', { name: 'octo/gallery' }).click()
  await expect(page).toHaveURL(/\/octo\/gallery$/)
  await expect(page.getByRole('heading', { name: 'Gallery', exact: true })).toBeVisible()
  await expect(page.getByText('octo/hidden')).toHaveCount(0)
  await page.getByRole('table', { name: 'Files' }).getByRole('link', { name: 'src' }).click()
  await page.getByRole('link', { name: 'app.ts' }).click()
  await expect(page.locator('#L1')).toContainText('Hello, ${name}!')
  await page.getByRole('link', { name: '1', exact: true }).click()
  await expect(page).toHaveURL(/#L1$/)
  expect(await page.locator('#L1').evaluate((row) => getComputedStyle(row).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  expect(await page.locator('#L1 td').first().evaluate((cell) => getComputedStyle(cell).userSelect)).toBe('none')
  await noHorizontalScroll(page)
  await page.getByRole('link', { name: 'History' }).click()
  await expect(page.getByRole('link', { name: 'Punctuate the greeting' }).first()).toBeVisible()
  await page.getByRole('link', { name: 'Punctuate the greeting' }).first().click()
  await expect(page.getByText('Showing 1 changed file')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Modified src/app.ts' })).toContainText('Hello, ${name}!')
})

test('previews an LFS image through the media URL', async ({ page }) => {
  await page.goto(url('/octo/gallery/blob/main/images/pixel.png'))
  await expect(page.getByText('Git LFS')).toBeVisible()
  const image = page.getByRole('img', { name: 'pixel.png' })
  await expect(image).toBeVisible()
  expect(await image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(8)
  await expect(image).toHaveAttribute('src', /\/octo\/gallery\/media\/[0-9a-f]{64}\/pixel\.png$/)
})

test('follows relative README links to directories', async ({ page }) => {
  await page.goto(url('/octo/gallery'))
  await page.locator('article').getByRole('link', { name: 'images' }).click()
  await expect(page).toHaveURL(/\/octo\/gallery\/tree\/main\/images$/)
  await expect(page.getByRole('link', { name: 'pixel.png' })).toBeVisible()
})

test('answers private and unknown repositories with 404', async ({ page }) => {
  const hidden = await page.goto(url('/octo/hidden'))
  expect(hidden?.status()).toBe(404)
  await expect(page.getByRole('link', { name: 'Sign in' }).last()).toBeVisible()
  expect((await page.goto(url('/octo/gallery/blob/main/nope.txt')))?.status()).toBe(404)
})

test('follows the system colour scheme', async ({ browser }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ colorScheme })
    const page = await context.newPage()
    await page.goto(url('/octo/gallery/blob/main/src/app.ts'))
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const keyword = await page.locator('#L1 span').first().evaluate((element) => getComputedStyle(element).color)
    expect({ colorScheme, dark: background.startsWith('oklch(0.2') || background.startsWith('rgb(29') }).toEqual({ colorScheme, dark: colorScheme === 'dark' })
    expect(keyword).not.toBe('rgb(0, 0, 0)')
    await context.close()
  }
})

test('serves the stylesheet with an immutable cache header', async ({ request }) => {
  const html = await (await request.get(url('/'))).text()
  const href = /<link rel="stylesheet" href="([^"]+)"/.exec(html)![1]!
  const css = await request.get(url(href))
  expect(css.headers()['cache-control']).toBe('public, max-age=31536000, immutable')
  expect(css.headers()['content-type']).toContain('text/css')
})
