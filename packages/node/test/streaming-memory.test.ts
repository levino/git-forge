import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const script = fileURLToPath(new URL('./memory-push.ts', import.meta.url))

describe('streaming push and clone', () => {
  it('keeps memory bounded for a pack much larger than the memory budget', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--experimental-transform-types', '--no-warnings', '--expose-gc', '--max-old-space-size=96', script, '64', '4', '1'],
      { maxBuffer: 1024 * 1024, timeout: 240_000 },
    )
    const result = JSON.parse(stdout.trim().split('\n').pop() as string) as { packMiB: number; pushPeakMiB: number; clonePeakMiB: number; fsck: string }
    expect(result.packMiB).toBeGreaterThan(60)
    expect(result.fsck).toBe('')
    expect(result.pushPeakMiB).toBeLessThan(result.packMiB / 3)
    expect(result.clonePeakMiB).toBeLessThan(result.packMiB / 1.5)
  }, 300_000)
})
