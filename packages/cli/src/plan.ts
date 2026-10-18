export type ObjectId = string

export type GitOps = {
  firstParentLine(tip: ObjectId, negatives: readonly ObjectId[]): Promise<ObjectId[]>
  parents(commit: ObjectId): Promise<ObjectId[]>
  covered(commit: ObjectId, negatives: readonly ObjectId[]): Promise<boolean>
  estimate(tip: ObjectId, negatives: readonly ObjectId[]): Promise<number>
  packSize(tip: ObjectId, negatives: readonly ObjectId[], limit: number): Promise<number>
}

export type Chunk = {
  readonly commit: ObjectId
  readonly ref: string
  readonly bytes: number
}

export class CommitTooLargeError extends Error {
  readonly commit: ObjectId
  readonly bytes: number
  readonly budget: number

  constructor(commit: ObjectId, bytes: number, budget: number) {
    super(`commit ${commit} alone needs a pack of more than ${bytes} bytes, above the budget of ${budget} bytes`)
    this.commit = commit
    this.bytes = bytes
    this.budget = budget
  }
}

export const REQUEST_OVERHEAD = 4096

export type PlanContext = {
  readonly ops: GitOps
  readonly budget: number
  readonly negatives: Set<ObjectId>
  readonly sideRef: () => string
}

const packLimit = (context: PlanContext): number => context.budget - REQUEST_OVERHEAD

export const fits = async (context: PlanContext, tip: ObjectId): Promise<{ ok: boolean; bytes: number }> => {
  const limit = packLimit(context)
  const bytes = await context.ops.packSize(tip, [...context.negatives], limit)
  return { ok: bytes <= limit, bytes }
}

const furthestByEstimate = async (context: PlanContext, line: readonly ObjectId[], from: number, target: number): Promise<number> => {
  const negatives = [...context.negatives]
  let low = from
  let high = line.length - 1
  if ((await context.ops.estimate(line[high] as ObjectId, negatives)) <= target) return high
  if ((await context.ops.estimate(line[low] as ObjectId, negatives)) > target) return low
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if ((await context.ops.estimate(line[middle] as ObjectId, negatives)) <= target) low = middle
    else high = middle
  }
  return low
}

const furthestByPackSize = async (context: PlanContext, line: readonly ObjectId[], from: number, below: number): Promise<{ index: number; bytes: number } | null> => {
  let best: { index: number; bytes: number } | null = null
  let low = from
  let high = below - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const result = await fits(context, line[middle] as ObjectId)
    if (result.ok) {
      best = { index: middle, bytes: result.bytes }
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

export const furthestFitting = async (context: PlanContext, line: readonly ObjectId[], from: number): Promise<{ index: number; bytes: number } | null> => {
  const limit = packLimit(context)
  let factor = 1
  let best: { index: number; bytes: number } | null = null
  let overshoot = line.length
  for (let attempt = 0; attempt < 6; attempt++) {
    const index = Math.min(await furthestByEstimate(context, line, from, limit * factor), overshoot - 1)
    if (index < from) break
    if (best && index <= best.index) break
    const result = await fits(context, line[index] as ObjectId)
    if (!result.ok) {
      overshoot = index
      factor *= (0.9 * limit) / result.bytes
      continue
    }
    best = { index, bytes: result.bytes }
    if (index === line.length - 1 || result.bytes >= 0.6 * limit) return best
    factor *= Math.min(4, (0.9 * limit) / Math.max(result.bytes, 1))
  }
  if (best) return best
  return furthestByPackSize(context, line, from, overshoot)
}

export async function* planChunks(context: PlanContext, tip: ObjectId, ref: string): AsyncGenerator<Chunk> {
  const line = await context.ops.firstParentLine(tip, [...context.negatives])
  let position = 0
  while (position < line.length) {
    const found = await furthestFitting(context, line, position)
    if (found) {
      const commit = line[found.index] as ObjectId
      yield { commit, ref, bytes: found.bytes }
      context.negatives.add(commit)
      position = found.index + 1
      continue
    }
    const commit = line[position] as ObjectId
    const sides: ObjectId[] = []
    for (const parent of (await context.ops.parents(commit)).slice(1)) {
      if (!(await context.ops.covered(parent, [...context.negatives]))) sides.push(parent)
    }
    if (sides.length === 0) {
      const { bytes } = await fits(context, commit)
      throw new CommitTooLargeError(commit, bytes, context.budget)
    }
    for (const side of sides) yield* planChunks(context, side, context.sideRef())
  }
}
