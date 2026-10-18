export type TemplateToken =
  | string
  | boolean
  | number
  | null
  | { readonly type: 3; readonly expr: string }
  | { readonly type: 1; readonly seq?: readonly TemplateToken[] }
  | { readonly type: 2; readonly map?: readonly { readonly Key: TemplateToken; readonly Value: TemplateToken }[] }

export type ContextData =
  | string
  | boolean
  | number
  | null
  | { readonly t: 1; readonly a?: readonly ContextData[] }
  | { readonly t: 2; readonly d?: readonly { readonly k: string; readonly v: ContextData }[] }

export const mappingToken = (entries: Readonly<Record<string, TemplateToken>>): TemplateToken => {
  const map = Object.entries(entries).map(([Key, Value]) => ({ Key, Value }))
  return map.length === 0 ? { type: 2 } : { type: 2, map }
}

export const sequenceToken = (items: readonly TemplateToken[]): TemplateToken => (items.length === 0 ? { type: 1 } : { type: 1, seq: items })

export const contextDictionary = (entries: Readonly<Record<string, ContextData>>): ContextData => {
  const d = Object.entries(entries).map(([k, v]) => ({ k, v }))
  return d.length === 0 ? { t: 2 } : { t: 2, d }
}

export const contextArray = (items: readonly ContextData[]): ContextData => (items.length === 0 ? { t: 1 } : { t: 1, a: items })

const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g

const quote = (text: string): string => `'${text.replace(/'/g, "''")}'`

export const expressionToken = (text: string): TemplateToken => {
  const parts: { literal: string; expression?: string }[] = []
  let last = 0
  for (const match of text.matchAll(EXPRESSION)) {
    parts.push({ literal: text.slice(last, match.index), expression: match[1]!.trim() })
    last = match.index + match[0].length
  }
  if (parts.length === 0) return text
  const tail = text.slice(last)
  if (parts.length === 1 && parts[0]!.literal === '' && tail === '') return { type: 3, expr: parts[0]!.expression! }
  const format = parts.map((part, index) => `${part.literal.replace(/[{}]/g, (brace) => brace + brace)}{${index}}`).join('') + tail.replace(/[{}]/g, (brace) => brace + brace)
  return { type: 3, expr: `format(${[quote(format), ...parts.map((part) => part.expression!)].join(', ')})` }
}

const STATUS_FUNCTION = /\b(success|failure|cancelled|always)\s*\(\s*\)/

export const stepCondition = (condition: string | undefined): string => {
  if (condition === undefined || condition.trim() === '') return 'success()'
  return STATUS_FUNCTION.test(condition) ? condition : `success() && (${condition})`
}
