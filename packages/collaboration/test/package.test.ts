import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = fileURLToPath(new URL('../src/', import.meta.url))

describe('package rules', () => {
  it('uses only web-standard APIs and no code comments in src', () => {
    for (const file of readdirSync(source)) {
      const text = readFileSync(`${source}${file}`, 'utf8')
      expect(text, file).not.toMatch(/from ['"]node:|require\(/)
      expect(text, file).not.toMatch(/^\s*\/\/|\/\*/m)
    }
  })
})
