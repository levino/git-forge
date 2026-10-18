import { describe, expect, it } from 'vitest'
import { parseYaml, YamlError } from '../src/index.ts'

describe('parseYaml', () => {
  it('parses nested mappings, sequences and scalars', () => {
    const text = [
      'name: CI # trailing comment',
      'on:',
      '  push:',
      '    branches: [main, "release/*"]',
      'env:',
      '  COUNT: 3',
      '  RATIO: 1.5',
      '  ENABLED: true',
      '  EMPTY: ~',
      "  QUOTED: 'it''s # not a comment'",
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Hello',
      '        run: echo "hi"',
      '      - uses: actions/checkout@v4',
      '        with: { fetch-depth: 0 }',
      '      -',
      '        run: ls',
    ].join('\n')
    expect(parseYaml(text)).toEqual({
      name: 'CI',
      on: { push: { branches: ['main', 'release/*'] } },
      env: { COUNT: 3, RATIO: 1.5, ENABLED: true, EMPTY: null, QUOTED: "it's # not a comment" },
      jobs: {
        build: {
          'runs-on': 'ubuntu-latest',
          steps: [{ name: 'Hello', run: 'echo "hi"' }, { uses: 'actions/checkout@v4', with: { 'fetch-depth': 0 } }, { run: 'ls' }],
        },
      },
    })
  })

  it('keeps block scalars verbatim including hashes and blank lines', () => {
    const text = ['run: |', '  echo one # kept', '', '    indented', 'strip: |-', '  a', '  b', 'folded: >', '  one', '  two', '', '  three', 'last: x'].join('\n')
    expect(parseYaml(text)).toEqual({ run: 'echo one # kept\n\n  indented\n', strip: 'a\nb', folded: 'one two\nthree\n', last: 'x' })
  })

  it('accepts sequences at the same indentation as their key and nested sequences', () => {
    expect(parseYaml('a:\n- 1\n- - x\n  - y\nb: "\\u00e9\\n"')).toEqual({ a: [1, ['x', 'y']], b: 'é\n' })
  })

  it('treats keys as strings, so "on" stays "on"', () => {
    expect(Object.keys(parseYaml('on: push\nyes: 1') as object)).toEqual(['on', 'yes'])
  })

  it('rejects what it does not support with a line number', () => {
    expect(() => parseYaml('a: &anchor 1')).toThrow(YamlError)
    expect(() => parseYaml('a: 1\na: 2')).toThrow(/line 2: duplicate key/)
    expect(() => parseYaml('a:\n\tb: 1')).toThrow(/tabs/)
    expect(() => parseYaml('a: 1\n---\nb: 2')).toThrow(/multiple documents/)
    expect(() => parseYaml('a:\n  b: 1\n    c: 2')).toThrow(YamlError)
  })
})
