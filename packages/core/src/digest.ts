import { createSha1, createSha256 } from './hash.ts'

export type DigestAlgorithm = 'SHA-1' | 'SHA-256'

export type StreamingDigest = {
  update(chunk: Uint8Array): void
  digest(): Promise<Uint8Array>
}

export type DigestFactory = (algorithm: DigestAlgorithm) => StreamingDigest

export const javascriptDigests: DigestFactory = (algorithm) => {
  const hash = algorithm === 'SHA-1' ? createSha1() : createSha256()
  return {
    update: (chunk) => void hash.update(chunk),
    digest: async () => hash.digest(),
  }
}
