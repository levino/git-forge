import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderMigrationsModule } from '../scripts/bundle-migrations.ts'
import { MIGRATION_NAME, splitStatements } from '../src/index.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('package rules', () => {
  it('keeps the bundled migrations in sync with migrations/*.sql', () => {
    expect(readFileSync(`${root}src/migrations.generated.ts`, 'utf8')).toBe(renderMigrationsModule(`${root}migrations/`))
  })

  it('names migrations NNNN_name.sql', () => {
    for (const file of readdirSync(`${root}migrations/`)) expect(file.replace(/\.sql$/, '')).toMatch(MIGRATION_NAME)
  })

  it('uses only web-standard APIs in src', () => {
    for (const file of readdirSync(`${root}src/`)) {
      expect(readFileSync(`${root}src/${file}`, 'utf8')).not.toMatch(/from ['"]node:|require\(/)
    }
  })

  it('splits migrations at statement breakpoints and keeps trigger bodies intact', () => {
    const statements = splitStatements('CREATE TABLE a (x);\n--> statement-breakpoint\nCREATE TRIGGER t BEFORE DELETE ON a\nBEGIN\n  SELECT 1;\nEND;\n')
    expect(statements).toEqual(['CREATE TABLE a (x);', 'CREATE TRIGGER t BEFORE DELETE ON a\nBEGIN\n  SELECT 1;\nEND;'])
  })
})
