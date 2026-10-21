import { vars } from './runtime.ts'

export const env = new Proxy({} as Record<string, string | undefined>, { get: (_, key) => (typeof key === 'string' ? vars()[key] : undefined) })

export class DurableObject {}
