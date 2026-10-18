import { readAll, utf8 } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { BackupKeyError, generateRecoveryKey, nameKeyFromSecret, opaqueName, openRun, parseRecoveryPrivateKey, parseRecoveryPublicKey, sealRun } from '../src/keys.ts'
import { BackupIntegrityError, openBytes, openStream, sealBytes, sealedSize, sealStream } from '../src/seal.ts'

const chunked = (bytes: Uint8Array, sizes: readonly number[]): ReadableStream<Uint8Array> => {
  let at = 0
  let turn = 0
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close()
      const size = sizes[turn++ % sizes.length] as number
      controller.enqueue(bytes.slice(at, at + size))
      at += size
    },
  })
}

const random = (size: number): Uint8Array => {
  const bytes = new Uint8Array(size)
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)))
  return bytes
}

const setup = async () => {
  const recovery = await generateRecoveryKey()
  const sealed = await sealRun(recovery.publicKey, 'run-1', new Date('2026-10-18T00:00:00Z'))
  const opened = await openRun(recovery.privateKey, sealed.record)
  return { recovery, sealed, keys: async () => opened }
}

describe('recovery keys', () => {
  it('derives the same run key from the private key', async () => {
    const { sealed, keys } = await setup()
    const bytes = await sealBytes(utf8('hello'), { run: 'run-1', runKey: sealed.key })
    expect(new TextDecoder().decode(await openBytes(bytes, keys))).toBe('hello')
  })

  it('refuses a run sealed to another recovery key', async () => {
    const { sealed } = await setup()
    const other = await generateRecoveryKey()
    await expect(openRun(other.privateKey, sealed.record)).rejects.toBeInstanceOf(BackupKeyError)
  })

  it('parses JWKs and rejects other key types', async () => {
    const { recovery } = await setup()
    expect(parseRecoveryPrivateKey(JSON.stringify(recovery.privateKey))).toEqual(recovery.privateKey)
    expect(parseRecoveryPublicKey(recovery.privateKey)).toEqual(recovery.publicKey)
    expect(() => parseRecoveryPublicKey({ kty: 'OKP', crv: 'Ed25519', x: recovery.publicKey.x })).toThrow(BackupKeyError)
    expect(() => parseRecoveryPublicKey('{')).toThrow(BackupKeyError)
  })

  it('derives stable opaque names from the backup secret', async () => {
    const a = await nameKeyFromSecret('x'.repeat(32))
    const b = await nameKeyFromSecret('y'.repeat(32))
    expect(await opaqueName(a, 'lfs:1')).toBe(await opaqueName(a, 'lfs:1'))
    expect(await opaqueName(a, 'lfs:1')).not.toBe(await opaqueName(b, 'lfs:1'))
    await expect(nameKeyFromSecret('short')).rejects.toBeInstanceOf(BackupKeyError)
  })
})

describe('sealed streams', () => {
  const segment = 1024
  for (const size of [0, 1, segment - 1, segment, segment + 1, 3 * segment, 5 * segment + 17]) {
    it(`round-trips ${size} bytes in odd chunks`, async () => {
      const { sealed, keys } = await setup()
      const plain = random(size)
      const sealedBytes = await readAll(chunked(plain, [7, 1000, 1]).pipeThrough(sealStream({ run: 'run-1', runKey: sealed.key, size, segment })))
      expect(sealedBytes.length).toBe(sealedSize(size, 'run-1', segment))
      const opened = await readAll(chunked(sealedBytes, [3, 2049, 512]).pipeThrough(openStream(keys)))
      expect(opened).toEqual(plain)
    })
  }

  it('produces different ciphertexts for the same plaintext', async () => {
    const { sealed } = await setup()
    const plain = utf8('same content')
    const a = await sealBytes(plain, { run: 'run-1', runKey: sealed.key })
    const b = await sealBytes(plain, { run: 'run-1', runKey: sealed.key })
    expect(a).not.toEqual(b)
  })

  it('detects tampering, truncation, reordering and appended data', async () => {
    const { sealed, keys } = await setup()
    const plain = random(4 * segment)
    const bytes = await sealBytes(plain, { run: 'run-1', runKey: sealed.key, segment })
    const flipped = bytes.slice()
    flipped[bytes.length - 100] = (flipped[bytes.length - 100] as number) ^ 1
    await expect(openBytes(flipped, keys)).rejects.toBeInstanceOf(BackupIntegrityError)
    const header = bytes.length - 4 * (segment + 16)
    const headerFlipped = bytes.slice()
    headerFlipped[header - 1] = (headerFlipped[header - 1] as number) ^ 1
    await expect(openBytes(headerFlipped, keys)).rejects.toBeInstanceOf(BackupIntegrityError)
    await expect(openBytes(bytes.slice(0, bytes.length - segment - 16), keys)).rejects.toBeInstanceOf(BackupIntegrityError)
    const swapped = bytes.slice()
    swapped.set(bytes.subarray(header, header + segment + 16), header + segment + 16)
    swapped.set(bytes.subarray(header + segment + 16, header + 2 * (segment + 16)), header)
    await expect(openBytes(swapped, keys)).rejects.toBeInstanceOf(BackupIntegrityError)
    const appended = new Uint8Array(bytes.length + 1)
    appended.set(bytes)
    await expect(openBytes(appended, keys)).rejects.toBeInstanceOf(BackupIntegrityError)
  })

  it('rejects input that differs from the declared size', async () => {
    const { sealed } = await setup()
    await expect(readAll(chunked(random(10), [10]).pipeThrough(sealStream({ run: 'run-1', runKey: sealed.key, size: 11 })))).rejects.toBeInstanceOf(BackupIntegrityError)
    await expect(readAll(chunked(random(12), [12]).pipeThrough(sealStream({ run: 'run-1', runKey: sealed.key, size: 11 })))).rejects.toBeInstanceOf(BackupIntegrityError)
  })
})
