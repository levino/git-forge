import type { DigestFactory } from '@git-forge/core'
import { createHash } from 'node:crypto'

const NAMES = { 'SHA-1': 'sha1', 'SHA-256': 'sha256' } as const

export const nodeDigests: DigestFactory = (algorithm) => {
  const hash = createHash(NAMES[algorithm])
  return {
    update: (chunk) => void hash.update(chunk),
    digest: async () => new Uint8Array(hash.digest()),
  }
}
