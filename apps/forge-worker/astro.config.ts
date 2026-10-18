import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'server',
  session: false,
  ...(process.env.ASTRO_WITHOUT_ADAPTER === '1' ? {} : { adapter: cloudflare({ imageService: 'passthrough' }) }),
  security: { checkOrigin: false },
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
  vite: { plugins: [tailwindcss()] },
})
