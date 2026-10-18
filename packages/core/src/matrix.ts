import { type ExpressionValue, toExpressionString } from './expression.ts'

export type MatrixCombination = Readonly<Record<string, ExpressionValue>>

export class MatrixError extends Error {}

export const MAX_MATRIX_COMBINATIONS = 256

const isObject = (value: ExpressionValue | undefined): value is { readonly [key: string]: ExpressionValue } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const deepEqual = (a: ExpressionValue, b: ExpressionValue): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item: ExpressionValue, index: number) => deepEqual(item, b[index] as ExpressionValue))
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && deepEqual(a[key]!, b[key]!))
  }
  return false
}

const entryList = (value: ExpressionValue | undefined, key: string): MatrixCombination[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || !value.every(isObject)) throw new MatrixError(`strategy.matrix.${key} must be a list of mappings`)
  return value as MatrixCombination[]
}

export const expandMatrix = (matrix: ExpressionValue): MatrixCombination[] => {
  if (!isObject(matrix)) throw new MatrixError('strategy.matrix must be a mapping')
  const include = entryList(matrix['include'], 'include')
  const exclude = entryList(matrix['exclude'], 'exclude')
  const vectors = Object.entries(matrix).filter(([key]) => key !== 'include' && key !== 'exclude')
  let combinations: Record<string, ExpressionValue>[] = vectors.length === 0 ? [] : [{}]
  for (const [key, values] of vectors) {
    if (!Array.isArray(values)) throw new MatrixError(`strategy.matrix.${key} must be a list`)
    if (values.length === 0) throw new MatrixError(`strategy.matrix.${key} must not be empty`)
    combinations = combinations.flatMap((combination) => values.map((value: ExpressionValue) => ({ ...combination, [key]: value })))
  }
  combinations = combinations.filter((combination) => !exclude.some((pattern) => Object.entries(pattern).every(([key, value]) => key in combination && matches(combination[key]!, value))))
  const original = new Set(vectors.map(([key]) => key))
  const extended = combinations.length
  for (const entry of include) {
    let applied = false
    for (let index = 0; index < extended; index++) {
      const combination = combinations[index]!
      if (Object.entries(entry).every(([key, value]) => !original.has(key) || deepEqual(combination[key]!, value))) {
        for (const [key, value] of Object.entries(entry)) if (!original.has(key)) combination[key] = value
        applied = true
      }
    }
    if (!applied) combinations.push({ ...entry })
  }
  if (combinations.length === 0) throw new MatrixError('strategy.matrix produces no jobs')
  if (combinations.length > MAX_MATRIX_COMBINATIONS) throw new MatrixError(`strategy.matrix produces more than ${MAX_MATRIX_COMBINATIONS} jobs`)
  return combinations
}

const matches = (value: ExpressionValue, pattern: ExpressionValue): boolean => {
  if (isObject(pattern) && isObject(value)) return Object.entries(pattern).every(([key, item]) => key in value && matches(value[key]!, item))
  return deepEqual(value, pattern)
}

const describe = (value: ExpressionValue): string => (typeof value === 'object' && value !== null ? JSON.stringify(value) : toExpressionString(value))

export const matrixJobName = (name: string, combination: MatrixCombination): string => {
  const values = Object.values(combination).map(describe)
  return values.length === 0 ? name : `${name} (${values.join(', ')})`
}
