import type { ObjectId } from './hash.ts'
import { fetchDumb, lsRefsDumb } from './dumb-client.ts'
import { expectOk, type Remote, RemoteError, type RemoteRefs, remoteRequest, remoteUrl } from './remote.ts'
import type { IngestOptions, ObjectDatabase } from './repository.ts'
import { fetchPackV2, HaveWalker, lsRefsV2, parseV2Advertisement, type V2Capabilities } from './smart-client.ts'

export type ProtocolPreference = 'auto' | 'v2' | 'dumb'

export type Protocol = 'v2' | 'dumb'

export type FetchObjectsOptions = {
  readonly wants: readonly ObjectId[]
  readonly haveTips: readonly ObjectId[]
  readonly isConnected: (id: ObjectId) => boolean
  readonly maxPackBytes?: number
  readonly pack?: IngestOptions
}

export type FetchObjectsResult = {
  readonly objects: number
  readonly packs: readonly string[]
  readonly rounds: number
}

export type RemoteConnection = {
  readonly protocol: Protocol
  readonly capabilities?: V2Capabilities
  listRefs(prefixes: readonly string[]): Promise<RemoteRefs>
  fetchObjects(odb: ObjectDatabase, options: FetchObjectsOptions): Promise<FetchObjectsResult>
}

const v2Connection = (remote: Remote, capabilities: V2Capabilities): RemoteConnection => ({
  protocol: 'v2',
  capabilities,
  listRefs: (prefixes) => lsRefsV2(remote, capabilities, prefixes),
  async fetchObjects(odb, options) {
    const fetched = await fetchPackV2(remote, capabilities, {
      wants: options.wants,
      haves: new HaveWalker(odb, options.haveTips),
      ...(options.maxPackBytes !== undefined ? { maxPackBytes: options.maxPackBytes } : {}),
    })
    const { name, pack } = await odb.ingest(fetched.pack, options.pack)
    return { objects: pack.objectCount, packs: name ? [name] : [], rounds: fetched.rounds }
  },
})

const dumbConnection = (remote: Remote, infoRefs?: string): RemoteConnection => ({
  protocol: 'dumb',
  listRefs: async (prefixes) => {
    const listing = await lsRefsDumb(remote, infoRefs)
    return { ...listing, refs: listing.refs.filter((ref) => prefixes.length === 0 || prefixes.some((prefix) => ref.name.startsWith(prefix))) }
  },
  async fetchObjects(odb, options) {
    const result = await fetchDumb(remote, odb, {
      wants: options.wants,
      isConnected: options.isConnected,
      ...(options.pack ? { pack: options.pack } : {}),
      ...(options.maxPackBytes !== undefined ? { maxPackBytes: options.maxPackBytes } : {}),
    })
    return { objects: result.objects, packs: result.packs, rounds: 0 }
  },
})

export const connectRemote = async (remote: Remote, preference: ProtocolPreference = 'auto'): Promise<RemoteConnection> => {
  if (preference === 'dumb') return dumbConnection(remote)
  const response = await expectOk(
    await remoteRequest(remote, remoteUrl(remote.url, 'info/refs?service=git-upload-pack'), { headers: { 'Git-Protocol': 'version=2' } }),
    'ref discovery',
  )
  const contentType = response.headers.get('Content-Type') ?? ''
  if (contentType.startsWith('application/x-git-upload-pack-advertisement')) {
    if (!response.body) throw new RemoteError('empty ref advertisement')
    const capabilities = await parseV2Advertisement(response.body)
    if (!capabilities) throw new RemoteError('remote does not support git protocol v2')
    return v2Connection(remote, capabilities)
  }
  if (preference === 'v2') {
    await response.body?.cancel()
    throw new RemoteError('remote is not a smart HTTP server')
  }
  return dumbConnection(remote, await response.text())
}
