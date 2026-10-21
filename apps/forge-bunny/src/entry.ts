import { createWorker } from 'forge-worker/host'
import { edgeForge } from './forge.ts'
import { serve } from './serve.ts'

const worker = createWorker({ forge: async () => (await edgeForge()).forge, sharedCache: true })

export default worker

export const start = (): void => serve(worker)
