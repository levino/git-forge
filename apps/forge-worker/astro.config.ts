import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'astro/config'

const version = process.env.GIT_FORGE_VERSION ?? readFileSync(new URL('../../release/VERSION', import.meta.url), 'utf8').trim()

export const forgeConfig = (options: { readonly configPath?: string; readonly outDir?: string } = {}) =>
  defineConfig({
    output: 'server',
    session: false,
    ...(options.outDir ? { outDir: options.outDir } : {}),
    ...(process.env.ASTRO_WITHOUT_ADAPTER === '1' ? {} : { adapter: cloudflare({ imageService: 'passthrough', ...(options.configPath ? { configPath: options.configPath } : {}) }) }),
    security: { checkOrigin: false },
    build: { inlineStylesheets: 'always' },
    devToolbar: { enabled: false },
    vite: { plugins: [tailwindcss()], define: { GIT_FORGE_VERSION: JSON.stringify(version) } },
  })

export default forgeConfig()
