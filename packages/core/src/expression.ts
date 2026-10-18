export type ExpressionValue = null | boolean | number | string | readonly ExpressionValue[] | { readonly [key: string]: ExpressionValue }

export type StatusFunctions = {
  readonly success: () => boolean
  readonly failure: () => boolean
  readonly cancelled: () => boolean
  readonly always: () => boolean
}

export type ExpressionContext = {
  readonly contexts: Readonly<Record<string, ExpressionValue>>
  readonly status?: StatusFunctions
}

export class ExpressionError extends Error {}

type Token =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'op'; readonly value: string }

type Node =
  | { readonly kind: 'literal'; readonly value: ExpressionValue }
  | { readonly kind: 'context'; readonly name: string }
  | { readonly kind: 'member'; readonly target: Node; readonly key: Node | '*' }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] }
  | { readonly kind: 'not'; readonly operand: Node }
  | { readonly kind: 'binary'; readonly op: string; readonly left: Node; readonly right: Node }

const NUMBER = /^-?(?:0x[0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/

const OPERATORS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '(', ')', '[', ']', '.', ',', '*']

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (char === "'") {
      let value = ''
      i++
      for (;;) {
        if (i >= source.length) throw new ExpressionError(`unterminated string in "${source}"`)
        if (source[i] === "'") {
          if (source[i + 1] === "'") {
            value += "'"
            i += 2
            continue
          }
          i++
          break
        }
        value += source[i]
        i++
      }
      tokens.push({ kind: 'string', value })
      continue
    }
    const previous = tokens[tokens.length - 1]
    const afterValue = previous !== undefined && (previous.kind !== 'op' || previous.value === ')' || previous.value === ']')
    const number = afterValue ? null : NUMBER.exec(source.slice(i))
    if (number) {
      const text = number[0]
      const negative = text.startsWith('-')
      const digits = negative ? text.slice(1) : text
      const magnitude = /^0x/i.test(digits) ? parseInt(digits, 16) : Number(digits)
      tokens.push({ kind: 'number', value: negative ? -magnitude : magnitude })
      i += text.length
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(source.slice(i))
    if (name) {
      tokens.push({ kind: 'name', value: name[0] })
      i += name[0].length
      continue
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i))
    if (!op) throw new ExpressionError(`unexpected "${char}" in "${source}"`)
    tokens.push({ kind: 'op', value: op })
    i += op.length
  }
  return tokens
}

const PRECEDENCE: Readonly<Record<string, number>> = { '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4 }

class Parser {
  #position = 0

  constructor(
    private readonly tokens: readonly Token[],
    private readonly source: string,
  ) {}

  parse(): Node {
    const node = this.#binary(0)
    if (this.#position < this.tokens.length) throw new ExpressionError(`unexpected token in "${this.source}"`)
    return node
  }

  #peek(): Token | undefined {
    return this.tokens[this.#position]
  }

  #isOp(value: string): boolean {
    const token = this.#peek()
    return token?.kind === 'op' && token.value === value
  }

  #expect(value: string): void {
    if (!this.#isOp(value)) throw new ExpressionError(`expected "${value}" in "${this.source}"`)
    this.#position++
  }

  #binary(minimum: number): Node {
    let left = this.#unary()
    for (;;) {
      const token = this.#peek()
      const precedence = token?.kind === 'op' ? PRECEDENCE[token.value] : undefined
      if (precedence === undefined || precedence < minimum) break
      this.#position++
      const right = this.#binary(precedence + 1)
      left = { kind: 'binary', op: (token as Token).value as string, left, right }
    }
    return left
  }

  #unary(): Node {
    if (this.#isOp('!')) {
      this.#position++
      return { kind: 'not', operand: this.#unary() }
    }
    return this.#postfix(this.#primary())
  }

  #primary(): Node {
    const token = this.tokens[this.#position++]
    if (!token) throw new ExpressionError(`unexpected end of "${this.source}"`)
    if (token.kind === 'number' || token.kind === 'string') return { kind: 'literal', value: token.value }
    if (token.kind === 'op' && token.value === '(') {
      const inner = this.#binary(0)
      this.#expect(')')
      return inner
    }
    if (token.kind !== 'name') throw new ExpressionError(`unexpected "${token.value}" in "${this.source}"`)
    if (token.value === 'true') return { kind: 'literal', value: true }
    if (token.value === 'false') return { kind: 'literal', value: false }
    if (token.value === 'null') return { kind: 'literal', value: null }
    if (token.value === 'NaN') return { kind: 'literal', value: Number.NaN }
    if (token.value === 'Infinity') return { kind: 'literal', value: Number.POSITIVE_INFINITY }
    if (this.#isOp('(')) {
      this.#position++
      const args: Node[] = []
      if (!this.#isOp(')')) {
        for (;;) {
          args.push(this.#binary(0))
          if (this.#isOp(',')) {
            this.#position++
            continue
          }
          break
        }
      }
      this.#expect(')')
      return { kind: 'call', name: token.value.toLowerCase(), args }
    }
    return { kind: 'context', name: token.value }
  }

  #postfix(node: Node): Node {
    for (;;) {
      if (this.#isOp('.')) {
        this.#position++
        const token = this.tokens[this.#position++]
        if (token?.kind === 'op' && token.value === '*') node = { kind: 'member', target: node, key: '*' }
        else if (token?.kind === 'name') node = { kind: 'member', target: node, key: { kind: 'literal', value: token.value } }
        else throw new ExpressionError(`expected a property name in "${this.source}"`)
      } else if (this.#isOp('[')) {
        this.#position++
        if (this.#isOp('*')) {
          this.#position++
          node = { kind: 'member', target: node, key: '*' }
        } else node = { kind: 'member', target: node, key: this.#binary(0) }
        this.#expect(']')
      } else return node
    }
  }
}

export const parseExpression = (source: string): Node => new Parser(tokenize(source), source).parse()

const isObject = (value: ExpressionValue): value is { readonly [key: string]: ExpressionValue } => typeof value === 'object' && value !== null && !Array.isArray(value)

export const isTruthy = (value: ExpressionValue): boolean => {
  if (value === null || value === false || value === '') return false
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  return true
}

const toNumber = (value: ExpressionValue): number => {
  if (value === null) return 0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return 0
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return parseInt(trimmed, 16)
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : Number.NaN
  }
  return Number.NaN
}

export const toExpressionString = (value: ExpressionValue): string => {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isInteger(value) || !Number.isFinite(value) ? String(value) : String(Number(value.toPrecision(15)))
  if (typeof value === 'string') return value
  return Array.isArray(value) ? 'Array' : 'Object'
}

const looseEquals = (left: ExpressionValue, right: ExpressionValue): boolean => {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase()
  if (typeof left === typeof right && (left === null || typeof left !== 'object')) return left === right
  if ((typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null)) return left === right
  return toNumber(left) === toNumber(right)
}

const compare = (left: ExpressionValue, right: ExpressionValue): number => {
  if (typeof left === 'string' && typeof right === 'string') {
    const a = left.toLowerCase()
    const b = right.toLowerCase()
    return a < b ? -1 : a > b ? 1 : 0
  }
  const a = toNumber(left)
  const b = toNumber(right)
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN
  return a < b ? -1 : a > b ? 1 : 0
}

const property = (target: ExpressionValue, key: ExpressionValue): ExpressionValue => {
  if (Array.isArray(target)) {
    const index = toNumber(key)
    return Number.isInteger(index) && index >= 0 && index < target.length ? (target[index] as ExpressionValue) : null
  }
  if (isObject(target) && typeof key === 'string') {
    const exact = target[key]
    if (exact !== undefined) return exact
    const lower = key.toLowerCase()
    const match = Object.keys(target).find((candidate) => candidate.toLowerCase() === lower)
    return match === undefined ? null : (target[match] as ExpressionValue)
  }
  return null
}

const toJson = (value: ExpressionValue): string => JSON.stringify(value, null, 2)

const fromJson = (text: ExpressionValue): ExpressionValue => {
  const source = toExpressionString(text)
  if (source.trim() === '') throw new ExpressionError('fromJSON: empty input')
  try {
    return JSON.parse(source) as ExpressionValue
  } catch {
    throw new ExpressionError(`fromJSON: invalid JSON ${JSON.stringify(source.slice(0, 100))}`)
  }
}

const format = (args: readonly ExpressionValue[]): string => {
  const template = toExpressionString(args[0] ?? '')
  let result = ''
  for (let i = 0; i < template.length; i++) {
    const char = template[i]!
    if (char === '{' && template[i + 1] === '{') {
      result += '{'
      i++
    } else if (char === '}' && template[i + 1] === '}') {
      result += '}'
      i++
    } else if (char === '{') {
      const end = template.indexOf('}', i)
      const index = end === -1 ? Number.NaN : Number(template.slice(i + 1, end))
      if (!Number.isInteger(index) || index < 0 || index + 1 >= args.length) throw new ExpressionError(`format: invalid placeholder in "${template}"`)
      result += toExpressionString(args[index + 1]!)
      i = end
    } else result += char
  }
  return result
}

const FUNCTIONS: Readonly<Record<string, readonly [number, number]>> = {
  contains: [2, 2],
  startswith: [2, 2],
  endswith: [2, 2],
  format: [1, Number.POSITIVE_INFINITY],
  join: [1, 2],
  tojson: [1, 1],
  fromjson: [1, 1],
  success: [0, 0],
  failure: [0, 0],
  cancelled: [0, 0],
  always: [0, 0],
  hashfiles: [1, Number.POSITIVE_INFINITY],
}

const call = (name: string, args: readonly ExpressionValue[], context: ExpressionContext): ExpressionValue => {
  const arity = FUNCTIONS[name]
  if (!arity) throw new ExpressionError(`unknown function ${name}()`)
  if (args.length < arity[0] || args.length > arity[1]) throw new ExpressionError(`${name}() takes ${arity[0]}${arity[1] === arity[0] ? '' : ' or more'} arguments`)
  switch (name) {
    case 'contains': {
      const [haystack, needle] = args as [ExpressionValue, ExpressionValue]
      if (Array.isArray(haystack)) return haystack.some((item: ExpressionValue) => looseEquals(item, needle))
      return toExpressionString(haystack).toLowerCase().includes(toExpressionString(needle).toLowerCase())
    }
    case 'startswith':
      return toExpressionString(args[0]!).toLowerCase().startsWith(toExpressionString(args[1]!).toLowerCase())
    case 'endswith':
      return toExpressionString(args[0]!).toLowerCase().endsWith(toExpressionString(args[1]!).toLowerCase())
    case 'format':
      return format(args)
    case 'join': {
      const separator = args.length > 1 ? toExpressionString(args[1]!) : ','
      return Array.isArray(args[0]) ? args[0].map((item: ExpressionValue) => toExpressionString(item)).join(separator) : toExpressionString(args[0]!)
    }
    case 'tojson':
      return toJson(args[0]!)
    case 'fromjson':
      return fromJson(args[0]!)
    case 'hashfiles':
      throw new ExpressionError('hashFiles() is only available on the runner')
    default: {
      const status = context.status
      if (!status) throw new ExpressionError(`${name}() is not available here`)
      return status[name as keyof StatusFunctions]()
    }
  }
}

const evaluateNode = (node: Node, context: ExpressionContext): ExpressionValue => {
  switch (node.kind) {
    case 'literal':
      return node.value
    case 'context': {
      const value = context.contexts[node.name]
      if (value === undefined) throw new ExpressionError(`unrecognized named-value: '${node.name}'`)
      return value
    }
    case 'member': {
      const target = evaluateNode(node.target, context)
      if (node.key === '*') {
        if (Array.isArray(target)) return target
        return isObject(target) ? Object.values(target) : []
      }
      const key = evaluateNode(node.key, context)
      if (node.target.kind === 'member' && node.target.key === '*' && Array.isArray(target)) return target.map((item: ExpressionValue) => property(item, key)).filter((item: ExpressionValue) => item !== null)
      return property(target, typeof key === 'number' ? key : toExpressionString(key))
    }
    case 'call':
      return call(
        node.name,
        node.args.map((arg) => evaluateNode(arg, context)),
        context,
      )
    case 'not':
      return !isTruthy(evaluateNode(node.operand, context))
    case 'binary': {
      if (node.op === '&&') {
        const left = evaluateNode(node.left, context)
        return isTruthy(left) ? evaluateNode(node.right, context) : left
      }
      if (node.op === '||') {
        const left = evaluateNode(node.left, context)
        return isTruthy(left) ? left : evaluateNode(node.right, context)
      }
      const left = evaluateNode(node.left, context)
      const right = evaluateNode(node.right, context)
      if (node.op === '==') return looseEquals(left, right)
      if (node.op === '!=') return !looseEquals(left, right)
      const order = compare(left, right)
      if (Number.isNaN(order)) return false
      if (node.op === '<') return order < 0
      if (node.op === '<=') return order <= 0
      if (node.op === '>') return order > 0
      return order >= 0
    }
  }
}

export const evaluateExpression = (source: string, context: ExpressionContext): ExpressionValue => evaluateNode(parseExpression(source), context)

const EMBEDDED = /\$\{\{([\s\S]*?)\}\}/g

const WHOLE = /^\s*\$\{\{([\s\S]*)\}\}\s*$/

export const hasExpression = (text: string): boolean => text.includes('${{')

export const evaluateTemplate = (text: string, context: ExpressionContext): ExpressionValue => {
  const whole = WHOLE.exec(text)
  if (whole && !whole[1]!.includes('}}')) return evaluateExpression(whole[1]!, context)
  return text.replace(EMBEDDED, (_, source: string) => toExpressionString(evaluateExpression(source, context)))
}

export const evaluateTemplateString = (text: string, context: ExpressionContext): string => toExpressionString(evaluateTemplate(text, context))

export const evaluateCondition = (condition: string, context: ExpressionContext): boolean => {
  const whole = WHOLE.exec(condition)
  return isTruthy(evaluateExpression(whole ? whole[1]! : condition, context))
}

export type YamlLike = null | boolean | number | string | readonly YamlLike[] | { readonly [key: string]: YamlLike }

export const evaluateValue = (value: YamlLike, context: ExpressionContext): ExpressionValue => {
  if (typeof value === 'string') return hasExpression(value) ? evaluateTemplate(value, context) : value
  if (Array.isArray(value)) return value.map((item: YamlLike) => evaluateValue(item, context))
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, ExpressionValue> = {}
    for (const [key, item] of Object.entries(value as { readonly [key: string]: YamlLike })) result[key] = evaluateValue(item, context)
    return result
  }
  return value
}

const STATUS_FUNCTION = /\b(success|failure|cancelled|always)\s*\(\s*\)/i

export const withStatusCheck = (condition: string | undefined): string => {
  if (condition === undefined || condition.trim() === '') return 'success()'
  const whole = WHOLE.exec(condition)
  const inner = (whole ? whole[1]! : condition).trim()
  return STATUS_FUNCTION.test(inner) ? inner : `success() && (${inner})`
}
