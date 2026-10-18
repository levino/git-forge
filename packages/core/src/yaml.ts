export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }

export class YamlError extends Error {
  readonly line: number

  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`)
    this.line = line
  }
}

type Line = {
  readonly number: number
  readonly indent: number
  readonly text: string
  readonly raw: string
  readonly blank: boolean
}

const stripComment = (text: string): string => {
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote) {
      if (quote === "'" && char === "'" && text[i + 1] === "'") i++
      else if (quote === '"' && char === '\\') i++
      else if (char === quote) quote = null
    } else if ((char === '"' || char === "'") && (i === 0 || /[\s[{,:-]/.test(text[i - 1]!))) {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      return text.slice(0, i).trimEnd()
    }
  }
  return text.trimEnd()
}

const toLines = (source: string): Line[] =>
  source
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((raw, index) => {
      const number = index + 1
      const indent = raw.length - raw.trimStart().length
      if (/^\s*\t/.test(raw) && raw.trim() !== '') throw new YamlError('tabs are not allowed for indentation', number)
      const text = stripComment(raw.slice(indent))
      return { number, indent, text, raw, blank: text === '' }
    })

const isSequenceItem = (text: string): boolean => text === '-' || text.startsWith('- ')

const findMappingColon = (text: string): number => {
  let quote: string | null = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote) {
      if (quote === "'" && char === "'" && text[i + 1] === "'") i++
      else if (quote === '"' && char === '\\') i++
      else if (char === quote) quote = null
      continue
    }
    if ((char === '"' || char === "'") && i === 0) quote = char
    else if (char === '[' || char === '{') {
      if (i === 0) return -1
      depth++
    } else if (char === ']' || char === '}') depth--
    else if (char === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return i
  }
  return -1
}

const unquoteDouble = (body: string, line: number): string =>
  body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, escape: string) => {
    if (escape.startsWith('u') || escape.startsWith('x')) return String.fromCharCode(parseInt(escape.slice(1), 16))
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ', e: '\x1b' }
    const value = map[escape]
    if (value === undefined) throw new YamlError(`unknown escape \\${escape}`, line)
    return value
  })

const parseKey = (text: string, line: number): string => {
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return unquoteDouble(text.slice(1, -1), line)
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'")
  if (text === '') throw new YamlError('empty mapping key', line)
  return text
}

const plainScalar = (text: string, line: number): YamlValue => {
  if (/^[&*!]/.test(text)) throw new YamlError('anchors, aliases and tags are not supported', line)
  if (/^(true|True|TRUE)$/.test(text)) return true
  if (/^(false|False|FALSE)$/.test(text)) return false
  if (/^(null|Null|NULL|~)$/.test(text)) return null
  if (/^[-+]?\d+$/.test(text)) return Number(text)
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text)
  return text
}

class FlowParser {
  #position = 0
  readonly #text: string
  readonly #line: number

  constructor(text: string, line: number) {
    this.#text = text
    this.#line = line
  }

  parse(): YamlValue {
    const value = this.#value()
    this.#skipSpace()
    if (this.#position !== this.#text.length) throw new YamlError(`unexpected "${this.#text.slice(this.#position)}"`, this.#line)
    return value
  }

  #skipSpace(): void {
    while (this.#text[this.#position] === ' ') this.#position++
  }

  #value(): YamlValue {
    this.#skipSpace()
    const char = this.#text[this.#position]
    if (char === '[') return this.#sequence()
    if (char === '{') return this.#mapping()
    if (char === '"' || char === "'") return this.#quoted()
    const start = this.#position
    while (this.#position < this.#text.length && !',]}'.includes(this.#text[this.#position]!)) {
      if (this.#text[this.#position] === ':' && this.#text[this.#position + 1] === ' ') break
      this.#position++
    }
    return plainScalar(this.#text.slice(start, this.#position).trim(), this.#line)
  }

  #quoted(): string {
    const quote = this.#text[this.#position]!
    let i = this.#position + 1
    while (i < this.#text.length) {
      if (quote === "'" && this.#text[i] === "'" && this.#text[i + 1] === "'") i += 2
      else if (quote === '"' && this.#text[i] === '\\') i += 2
      else if (this.#text[i] === quote) break
      else i++
    }
    if (i >= this.#text.length) throw new YamlError('unterminated quoted string', this.#line)
    const body = this.#text.slice(this.#position + 1, i)
    this.#position = i + 1
    return quote === '"' ? unquoteDouble(body, this.#line) : body.replace(/''/g, "'")
  }

  #expect(char: string): void {
    this.#skipSpace()
    if (this.#text[this.#position] !== char) throw new YamlError(`expected "${char}"`, this.#line)
    this.#position++
  }

  #sequence(): YamlValue[] {
    this.#expect('[')
    const items: YamlValue[] = []
    this.#skipSpace()
    if (this.#text[this.#position] === ']') {
      this.#position++
      return items
    }
    for (;;) {
      items.push(this.#value())
      this.#skipSpace()
      if (this.#text[this.#position] === ',') {
        this.#position++
        continue
      }
      this.#expect(']')
      return items
    }
  }

  #mapping(): { [key: string]: YamlValue } {
    this.#expect('{')
    const result: { [key: string]: YamlValue } = {}
    this.#skipSpace()
    if (this.#text[this.#position] === '}') {
      this.#position++
      return result
    }
    for (;;) {
      const key = this.#value()
      this.#skipSpace()
      let value: YamlValue = null
      if (this.#text[this.#position] === ':') {
        this.#position++
        value = this.#value()
      }
      result[String(key)] = value
      this.#skipSpace()
      if (this.#text[this.#position] === ',') {
        this.#position++
        continue
      }
      this.#expect('}')
      return result
    }
  }
}

const inlineValue = (text: string, line: number): YamlValue => {
  if (text.startsWith('[') || text.startsWith('{') || text.startsWith('"') || text.startsWith("'")) return new FlowParser(text, line).parse()
  return plainScalar(text, line)
}

const BLOCK_HEADER = /^([|>])([-+]?)$/

class BlockParser {
  readonly #lines: Line[]

  constructor(lines: Line[]) {
    this.#lines = lines
  }

  next(index: number): number {
    let i = index
    while (i < this.#lines.length && this.#lines[i]!.blank) i++
    return i
  }

  node(index: number, minIndent: number): [YamlValue, number] {
    const i = this.next(index)
    const line = this.#lines[i]
    if (!line || line.indent < minIndent) return [null, i]
    if (isSequenceItem(line.text)) return this.sequence(i, line.indent)
    if (findMappingColon(line.text) !== -1) return this.mapping(i, line.indent)
    const following = this.#lines[this.next(i + 1)]
    if (following && following.indent >= line.indent && minIndent > 0) throw new YamlError('multi-line plain scalars are not supported', following.number)
    return [inlineValue(line.text, line.number), i + 1]
  }

  #valueAfterKey(rest: string, index: number, indent: number, line: Line): [YamlValue, number] {
    const header = BLOCK_HEADER.exec(rest)
    if (header) return this.blockScalar(index + 1, indent, header[1] as '|' | '>', header[2] as '' | '-' | '+')
    if (rest !== '') return [inlineValue(rest, line.number), index + 1]
    const next = this.next(index + 1)
    const nextLine = this.#lines[next]
    if (nextLine && nextLine.indent === indent && isSequenceItem(nextLine.text)) return this.sequence(next, indent)
    return this.node(index + 1, indent + 1)
  }

  mapping(index: number, indent: number): [YamlValue, number] {
    const result: { [key: string]: YamlValue } = {}
    let i = this.next(index)
    while (i < this.#lines.length) {
      const line = this.#lines[i]!
      if (line.indent < indent) break
      if (line.indent > indent) throw new YamlError('unexpected indentation', line.number)
      if (isSequenceItem(line.text)) break
      const colon = findMappingColon(line.text)
      if (colon === -1) throw new YamlError(`expected "key: value", got "${line.text}"`, line.number)
      const key = parseKey(line.text.slice(0, colon).trim(), line.number)
      if (key === '<<') throw new YamlError('merge keys are not supported', line.number)
      if (Object.hasOwn(result, key)) throw new YamlError(`duplicate key "${key}"`, line.number)
      const [value, after] = this.#valueAfterKey(line.text.slice(colon + 1).trim(), i, indent, line)
      result[key] = value
      i = this.next(after)
    }
    return [result, i]
  }

  sequence(index: number, indent: number): [YamlValue, number] {
    const items: YamlValue[] = []
    let i = this.next(index)
    while (i < this.#lines.length) {
      const line = this.#lines[i]!
      if (line.indent !== indent || !isSequenceItem(line.text)) {
        if (line.indent > indent) throw new YamlError('unexpected indentation', line.number)
        break
      }
      const rest = line.text.slice(1).trimStart()
      if (rest === '') {
        const [value, after] = this.node(i + 1, indent + 1)
        items.push(value)
        i = this.next(after)
        continue
      }
      const offset = line.raw.indexOf(rest, line.indent + 1)
      const header = BLOCK_HEADER.exec(rest)
      if (header) {
        const [value, after] = this.blockScalar(i + 1, indent, header[1] as '|' | '>', header[2] as '' | '-' | '+')
        items.push(value)
        i = this.next(after)
        continue
      }
      if (isSequenceItem(rest) || findMappingColon(rest) !== -1) {
        this.#lines[i] = { ...line, indent: offset, text: rest }
        const [value, after] = isSequenceItem(rest) ? this.sequence(i, offset) : this.mapping(i, offset)
        items.push(value)
        i = this.next(after)
        continue
      }
      items.push(inlineValue(rest, line.number))
      i = this.next(i + 1)
    }
    return [items, i]
  }

  blockScalar(index: number, parentIndent: number, style: '|' | '>', chomp: '' | '-' | '+'): [string, number] {
    let i = index
    const content: string[] = []
    let contentIndent = -1
    while (i < this.#lines.length) {
      const line = this.#lines[i]!
      const blank = line.raw.trim() === ''
      if (!blank && line.indent <= parentIndent) break
      if (!blank && contentIndent === -1) contentIndent = line.indent
      if (!blank && line.indent < contentIndent) throw new YamlError('block scalar line is less indented than the first line', line.number)
      content.push(blank ? '' : line.raw.slice(contentIndent))
      i++
    }
    let end = content.length
    while (end > 0 && content[end - 1] === '') end--
    const trailing = content.length - end
    const body = content.slice(0, end)
    let text: string
    if (style === '|') {
      text = body.join('\n')
    } else {
      text = ''
      for (let j = 0; j < body.length; j++) {
        const current = body[j]!
        if (j === 0) text = current
        else if (current === '' || current.startsWith(' ') || body[j - 1]!.startsWith(' ')) text += `\n${current}`
        else if (body[j - 1] === '') text += current
        else text += ` ${current}`
      }
    }
    if (body.length === 0) return ['', i]
    if (chomp === '-') return [text, i]
    if (chomp === '+') return [`${text}\n${'\n'.repeat(trailing)}`, i]
    return [`${text}\n`, i]
  }
}

export const parseYaml = (source: string): YamlValue => {
  const lines = toLines(source).filter((line, index, all) => !(line.text === '---' && line.indent === 0 && all.slice(0, index).every((before) => before.blank)))
  if (lines.some((line) => line.indent === 0 && (line.text === '---' || line.text === '...'))) throw new YamlError('multiple documents are not supported', 0)
  const parser = new BlockParser(lines)
  const [value, end] = parser.node(0, 0)
  const rest = parser.next(end)
  if (rest < lines.length) throw new YamlError(`unexpected content "${lines[rest]!.text}"`, lines[rest]!.number)
  return value
}
