import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const SIMULATOR_NOISE = [
  /^uncaught exception; source = Uncaught \(in promise\); stack = Error: Network connection lost\.$/,
  /^exception = kj\/async-io\.c\+\+:\d+: disconnected: fixed-length pipe ended prematurely$/,
  /^stack: (\S+workerd@[0-9a-f]+ ?)+$/,
]

const isNoise = (line: string): boolean => SIMULATOR_NOISE.some((pattern) => pattern.test(line))

const filterStream = (stream: NodeJS.WriteStream) => {
  const write = stream.write.bind(stream) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean
  stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    const lines = text.split('\n')
    const kept = lines.filter((line) => !isNoise(line))
    if (kept.length === lines.length) return write(chunk, ...rest)
    const remaining = kept.join('\n')
    return remaining.trim() === '' ? true : write(remaining, ...rest)
  }) as typeof stream.write
}

filterStream(process.stdout)
filterStream(process.stderr)

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-10-01',
        r2Buckets: ['BUCKET'],
      },
    }),
  ],
})
