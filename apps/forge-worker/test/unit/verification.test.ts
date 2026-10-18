import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeJwt, mintMirrorAttestation, verifyJwtSignature } from '@git-forge/accounts'
import { gitPrefix, readAll, type RepositoryName, setMirrorMode } from '@git-forge/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MirrorOverview } from '../../src/mirror-verification.ts'
import { git, tempDir } from '../e2e/history.ts'
import { type Instance, quiesce, startInstance } from '../support/federated-instance.ts'

const repo: RepositoryName = { owner: 'village', name: 'archive' }
const repository = 'village/archive'

let alpha: Instance
let beta: Instance
let source: string

const ok = async (response: Promise<Response>, status = 200): Promise<Response> => {
  const resolved = await response
  if (resolved.status !== status) throw new Error(`expected ${status}, got ${resolved.status}: ${await resolved.text()}`)
  return resolved
}

const overview = async (): Promise<MirrorOverview & { signed?: string }> => (await (await ok(alpha.api('GET', `/api/repos/${repository}/mirrors/overview`))).json()) as MirrorOverview

const commitAndPush = async (message: string) => {
  writeFileSync(join(source, `${message}.txt`), `${message}\n`)
  await git(source, ['add', '-A'])
  await git(source, ['commit', '-q', '-m', message])
  await git(source, ['push', '-q', alpha.gitUrl(repository, true), 'main'])
}

beforeAll(async () => {
  ;[alpha, beta] = await Promise.all([startInstance('alpha'), startInstance('beta')])
  for (const instance of [alpha, beta]) await ok(instance.api('POST', '/api/repos', { owner: repo.owner, name: repo.name }), 201)
  for (const [from, to] of [
    [alpha, beta],
    [beta, alpha],
  ] as const) {
    await ok(from.api('POST', '/api/admin/instances', { issuer: to.url }))
    await ok(from.api('POST', `/api/repos/${repository}/instances`, { issuer: to.url }))
  }
  source = tempDir()
  await git(source, ['init', '-q', '-b', 'main'])
  await commitAndPush('first')
  await ok(beta.api('POST', `/api/repos/${repository}/mirrors`, { url: alpha.gitUrl(repository), auth: 'instance' }), 201)
  await quiesce([alpha, beta])
}, 60_000)

afterAll(async () => {
  await Promise.all([alpha, beta].filter(Boolean).map((instance) => instance.close()))
})

describe('external mirror verification', () => {
  it('shows a mirror that attested the current ref state, with a passing spot check', async () => {
    const view = await overview()
    expect(view.repository).toBe(repository)
    expect(view.mirrors).toHaveLength(1)
    const [mirror] = view.mirrors
    expect(mirror).toMatchObject({ issuer: beta.url, subscribed: true, url: `${beta.url}/village/archive.git`, state: 'current', lagSeconds: 0, alarms: [] })
    expect(mirror!.attestation).toMatchObject({ checksum: view.checksum, refs: 1, namespace: '', alarms: 0, pending: 0 })
    expect(mirror!.spotCheck).toMatchObject({ ok: true, problems: [] })
    expect(mirror!.spotCheck!.samples).toBeGreaterThan(0)
    expect(alpha.jobs.failed).toEqual([])
    expect(beta.jobs.failed).toEqual([])

    const signed = decodeJwt(view.signed!)!
    expect(await verifyJwtSignature(alpha.key.publicJwk, signed)).toBe(true)
    expect(signed.payload).toMatchObject({ iss: alpha.url, sub: 'mirror-overview', overview: { repository, checksum: view.checksum } })
    const token = decodeJwt(mirror!.attestation!.token)!
    expect(token.payload).toMatchObject({ iss: beta.url, aud: alpha.url, sub: 'mirror-attestation', checksum: view.checksum })
  })

  it('reports the mirror as behind while it has not synced a newer push', async () => {
    await setMirrorMode(beta.storage, repo, 'manual')
    await commitAndPush('second')
    await quiesce([alpha, beta])
    const view = await overview()
    expect(view.mirrors[0]).toMatchObject({ state: 'behind', alarms: [] })
    expect(view.mirrors[0]!.lagSeconds).toBeGreaterThanOrEqual(0)
    expect(view.mirrors[0]!.attestation!.checksum).not.toBe(view.checksum)

    await ok(beta.api('POST', `/api/repos/${repository}/mirrors/origin/sync`))
    await quiesce([alpha, beta])
    expect((await overview()).mirrors[0]).toMatchObject({ state: 'current', lagSeconds: 0 })
  })

  it('raises an alarm when the mirror serves different bytes', async () => {
    const prefix = `${gitPrefix(repo)}objects/pack/`
    for await (const info of beta.storage.list(prefix)) {
      if (!info.key.endsWith('.pack')) continue
      const bytes = await readAll((await beta.storage.get(info.key))!.body)
      for (let i = 12; i < bytes.length - 20; i++) bytes[i] = (bytes[i] as number) ^ 0xff
      await beta.storage.put(info.key, bytes, bytes.length)
    }
    await alpha.jobs.enqueue({ kind: 'mirror-spot-check', repository, issuer: beta.url })
    await quiesce([alpha, beta])
    const [mirror] = (await overview()).mirrors
    expect(mirror!.spotCheck).toMatchObject({ ok: false })
    expect(mirror!.spotCheck!.problems.join('\n')).toContain('bytes differ')
    expect(mirror!.alarms).toContain('spot-check-failed')
  })

  it('flags an attested state the upstream never had as diverged', async () => {
    const token = await mintMirrorAttestation({
      key: beta.key,
      issuer: beta.url,
      audience: alpha.url,
      attestation: { repository, checksum: 'f'.repeat(40), refs: 1, namespace: '', syncedAt: new Date().toISOString(), alarms: 1, pending: 0 },
    })
    await ok(fetch(`${alpha.url}/api/federation/attestations`, { method: 'POST', body: token }), 202)
    expect((await overview()).mirrors[0]).toMatchObject({ state: 'diverged', lagSeconds: null })
    expect((await overview()).mirrors[0]!.alarms).toEqual(expect.arrayContaining(['diverged', 'mirror-alarms']))
  })

  it('accepts attestations only from trusted instances that may read the repository', async () => {
    const stranger = await startInstance('stranger')
    try {
      const forged = await mintMirrorAttestation({
        key: stranger.key,
        issuer: stranger.url,
        audience: alpha.url,
        attestation: { repository, checksum: '0'.repeat(40), refs: 0, namespace: '', syncedAt: new Date().toISOString(), alarms: 0, pending: 0 },
      })
      await ok(fetch(`${alpha.url}/api/federation/attestations`, { method: 'POST', body: forged }), 401)
      await ok(alpha.api('POST', '/api/admin/instances', { issuer: stranger.url }))
      await ok(fetch(`${alpha.url}/api/federation/attestations`, { method: 'POST', body: forged }), 404)
      expect((await overview()).mirrors.map((mirror) => mirror.issuer)).toEqual([beta.url])
    } finally {
      await stranger.close()
    }
  })

  it('needs read access to the repository', async () => {
    expect((await fetch(`${alpha.url}/api/repos/${repository}/mirrors/overview`)).status).toBe(401)
    expect((await alpha.api('GET', '/api/repos/village/missing/mirrors/overview')).status).toBe(404)
  })
})
