import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const appRoot = resolve(import.meta.dirname, '../..')

export const BUILT_ENTRY = resolve(appRoot, 'dist/server/entry.mjs')

export default async function setup(): Promise<void> {
  await promisify(execFile)(resolve(appRoot, 'node_modules/.bin/astro'), ['build'], {
    cwd: appRoot,
    env: { ...process.env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 64 * 1024 * 1024,
  })
}
