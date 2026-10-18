import { describe, expect, it } from 'vitest'
import {
  cronMatches,
  evaluateCondition,
  evaluateExpression,
  evaluateTemplate,
  evaluateValue,
  expandMatrix,
  type ExpressionContext,
  ExpressionError,
  MatrixError,
  matrixJobName,
  nextCronTime,
  parseCron,
  withStatusCheck,
} from '../src/index.ts'

const context: ExpressionContext = {
  contexts: {
    github: { ref: 'refs/heads/main', event_name: 'push', event: { commits: [{ id: 'a' }, { id: 'b' }] } },
    needs: { build: { result: 'success', outputs: { matrix: '{"os":["linux","mac"]}', 'dash-key': 'x' } }, test: { result: 'failure', outputs: {} } },
    matrix: { os: 'linux', node: 22 },
    inputs: { dry: false, count: 3 },
  },
  status: { success: () => false, failure: () => true, cancelled: () => false, always: () => true },
}

const evaluate = (source: string) => evaluateExpression(source, context)

describe('expressions', () => {
  it('evaluates literals, contexts and operators like GitHub', () => {
    expect(evaluate("github.ref == 'REFS/HEADS/MAIN'")).toBe(true)
    expect(evaluate("github['event_name']")).toBe('push')
    expect(evaluate('github.event.commits[1].id')).toBe('b')
    expect(evaluate('github.event.commits.*.id')).toEqual(['a', 'b'])
    expect(evaluate('needs.*.result')).toEqual(['success', 'failure'])
    expect(evaluate("needs.build.outputs.dash-key")).toBe('x')
    expect(evaluate('github.missing.deeper')).toBeNull()
    expect(evaluate("1 == '1'")).toBe(true)
    expect(evaluate("'' == 0")).toBe(true)
    expect(evaluate('null == false')).toBe(true)
    expect(evaluate('0x10 > -1.5e1')).toBe(true)
    expect(evaluate("'abc' < 'ABD'")).toBe(true)
    expect(evaluate("inputs.count >= 3 && 'yes' || 'no'")).toBe('yes')
    expect(evaluate("inputs.dry && 'yes' || 'no'")).toBe('no')
    expect(evaluate('!inputs.dry')).toBe(true)
    expect(evaluate("(1 == 2) || ('a' != 'b')")).toBe(true)
    expect(evaluate("'it''s'")).toBe("it's")
  })

  it('implements the functions', () => {
    expect(evaluate("contains(github.ref, 'MAIN')")).toBe(true)
    expect(evaluate("contains(needs.*.result, 'failure')")).toBe(true)
    expect(evaluate("startsWith(github.ref, 'refs/heads/')")).toBe(true)
    expect(evaluate("endsWith(github.ref, '/main')")).toBe(true)
    expect(evaluate("format('{0}-{{x}}-{1}', matrix.os, matrix.node)")).toBe('linux-{x}-22')
    expect(evaluate("join(github.event.commits.*.id, '+')")).toBe('a+b')
    expect(evaluate('fromJSON(needs.build.outputs.matrix).os[1]')).toBe('mac')
    expect(evaluate('toJSON(matrix)')).toBe('{\n  "os": "linux",\n  "node": 22\n}')
    expect(evaluate('failure() && always()')).toBe(true)
    expect(() => evaluate("hashFiles('**/x')")).toThrow(ExpressionError)
    expect(() => evaluate('unknown.thing')).toThrow("unrecognized named-value: 'unknown'")
    expect(() => evaluate('nope()')).toThrow(ExpressionError)
    expect(() => evaluate("fromJSON('')")).toThrow(ExpressionError)
    expect(() => evaluate('1 ==')).toThrow(ExpressionError)
  })

  it('evaluates templates, conditions and YAML values', () => {
    expect(evaluateTemplate('${{ matrix.node }}', context)).toBe(22)
    expect(evaluateTemplate('node-${{ matrix.node }} on ${{ matrix.os }}', context)).toBe('node-22 on linux')
    expect(evaluateValue({ os: '${{ fromJSON(needs.build.outputs.matrix).os }}', n: [1, '${{ inputs.count }}'] }, context)).toEqual({ os: ['linux', 'mac'], n: [1, 3] })
    expect(evaluateCondition("${{ matrix.os == 'linux' }}", context)).toBe(true)
    expect(withStatusCheck(undefined)).toBe('success()')
    expect(withStatusCheck("${{ github.ref == 'x' }}")).toBe("success() && (github.ref == 'x')")
    expect(withStatusCheck('always() && x')).toBe('always() && x')
  })
})

describe('matrix', () => {
  it('expands vectors with exclude and include like GitHub', () => {
    const combinations = expandMatrix({
      fruit: ['apple', 'pear'],
      animal: ['cat', 'dog'],
      exclude: [{ fruit: 'pear', animal: 'cat' }],
      include: [{ color: 'green' }, { color: 'pink', animal: 'cat' }, { fruit: 'apple', shape: 'circle' }, { fruit: 'banana' }, { fruit: 'banana', animal: 'cat' }],
    })
    expect(combinations).toEqual([
      { fruit: 'apple', animal: 'cat', color: 'pink', shape: 'circle' },
      { fruit: 'apple', animal: 'dog', color: 'green', shape: 'circle' },
      { fruit: 'pear', animal: 'dog', color: 'green' },
      { fruit: 'banana' },
      { fruit: 'banana', animal: 'cat' },
    ])
    expect(expandMatrix({ include: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }])
    expect(matrixJobName('test', { os: 'linux', node: 22 })).toBe('test (linux, 22)')
    expect(() => expandMatrix({ os: [] })).toThrow(MatrixError)
    expect(() => expandMatrix({ os: 'linux' })).toThrow(MatrixError)
    expect(() => expandMatrix({ a: Array.from({ length: 20 }, (_, i) => i), b: Array.from({ length: 20 }, (_, i) => i) })).toThrow('more than 256')
  })
})

describe('cron', () => {
  it('matches and finds the next time in UTC', () => {
    const every15 = parseCron('*/15 * * * *')
    expect(cronMatches(every15, Date.UTC(2026, 9, 18, 10, 30))).toBe(true)
    expect(cronMatches(every15, Date.UTC(2026, 9, 18, 10, 31))).toBe(false)
    expect(nextCronTime(every15, Date.UTC(2026, 9, 18, 10, 30))).toBe(Date.UTC(2026, 9, 18, 10, 45))
    const weekdays = parseCron('0 3 * * MON-FRI')
    expect(nextCronTime(weekdays, Date.UTC(2026, 9, 16, 4, 0))).toBe(Date.UTC(2026, 9, 19, 3, 0))
    const either = parseCron('0 0 1 * SUN')
    expect(cronMatches(either, Date.UTC(2026, 9, 18))).toBe(true)
    expect(cronMatches(either, Date.UTC(2026, 10, 1))).toBe(true)
    expect(cronMatches(either, Date.UTC(2026, 10, 2))).toBe(false)
    expect(nextCronTime(parseCron('0 0 29 2 *'), Date.UTC(2026, 0, 1))).toBe(Date.UTC(2028, 1, 29))
    expect(() => parseCron('* * *')).toThrow('five fields')
  })
})
