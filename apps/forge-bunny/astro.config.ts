import { fileURLToPath } from 'node:url'
import base from '../forge-worker/astro.config.ts'

const src = fileURLToPath(new URL('./src/', import.meta.url))

const host = {
  name: 'git-forge-bunny-host',
  enforce: 'pre' as const,
  resolveId(id: string, importer?: string) {
    if (id === './cloudflare.ts' && importer?.includes('/forge-worker/src/')) return `${src}host.ts`
    if (importer === `${src}host.ts` && id.startsWith('./') && !id.endsWith('host.ts')) return { id: `git-forge-bunny/${id.slice(2)}`, external: true }
    return null
  },
}

export default {
  ...base,
  outDir: fileURLToPath(new URL('./dist/astro/', import.meta.url)),
  vite: { ...base.vite, plugins: [...(base.vite?.plugins ?? []), host] },
}
