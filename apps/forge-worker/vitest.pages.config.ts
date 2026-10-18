import { getViteConfig } from 'astro/config'

process.env.ASTRO_WITHOUT_ADAPTER = '1'

export default getViteConfig({
  test: {
    include: ['test/pages/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
