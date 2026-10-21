import { fileURLToPath } from 'node:url'
import { forgeConfig } from '../forge-worker/astro.config.ts'

export default forgeConfig({ configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)), outDir: fileURLToPath(new URL('./dist/astro/', import.meta.url)) })
