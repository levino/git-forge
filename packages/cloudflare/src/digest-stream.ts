import type { DigestFactory } from '@git-forge/core'

export const digestStreams: DigestFactory = (algorithm) => {
  const stream = new crypto.DigestStream(algorithm)
  const writer = stream.getWriter()
  return {
    update: (chunk) => void writer.write(chunk).catch(() => undefined),
    digest: async () => {
      await writer.close()
      return new Uint8Array(await stream.digest)
    },
  }
}
