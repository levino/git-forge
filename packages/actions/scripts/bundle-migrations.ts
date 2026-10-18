import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../migrations/', import.meta.url))
const target = fileURLToPath(new URL('../src/migrations.generated.ts', import.meta.url))

export const renderMigrationsModule = (dir: string): string => {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
  const entries = files.map((file) => `  { name: ${JSON.stringify(file.replace(/\.sql$/, ''))}, sql: ${JSON.stringify(readFileSync(`${dir}${file}`, 'utf8'))} },`)
  return `import type { Migration } from '@git-forge/accounts'\n\nexport const ACTIONS_MIGRATIONS: readonly Migration[] = [\n${entries.join('\n')}\n]\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(target, renderMigrationsModule(directory))
