import type { Forge } from 'forge-worker/app'
import type { ForgeVars } from 'forge-worker/config'
import { edgeForge } from './forge.ts'

export type Env = ForgeVars

export const forgeFor = async (_env: Env): Promise<Forge> => (await edgeForge()).forge

export const sessionsFor = async (_env: Env) => ({
  run: async <T>(_start: string | null, run: () => Promise<T>) => ({ value: await run(), bookmark: null, wrote: false }),
})

export const backgroundHandlers = {}
