import { MemoryStorage } from '../src/memory-storage.ts'
import { parsePack } from '../src/pack.ts'
import { createRepository, ObjectDatabase, type RepositoryName } from '../src/repository.ts'
import { updateRefs } from '../src/ref-update.ts'
import { ZERO_ID } from '../src/hash.ts'
import { git, gitBytes } from './git-helpers.ts'

export const loadRepository = async (dir: string, repo: RepositoryName = { owner: 'acme', name: 'site' }, storage = new MemoryStorage()) => {
  await createRepository(storage, repo)
  const odb = new ObjectDatabase(storage, repo)
  const revs = git(dir, ['rev-list', '--all', '--objects']).trim()
  if (revs !== '') {
    const pack = gitBytes(dir, ['pack-objects', '--stdout', '--all'], '')
    const parsed = await parsePack(pack, async () => null)
    await odb.addPack(pack, parsed.objects, parsed.checksum)
  }
  const refs = git(dir, ['for-each-ref', '--format=%(objectname) %(refname)'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(' ') as [string, string])
  const result = await updateRefs(storage, repo, refs.map(([id, name]) => ({ name, oldId: ZERO_ID, newId: id })), odb)
  if (!result.ok) throw new Error('could not load refs')
  return { storage, repo, odb: new ObjectDatabase(storage, repo) }
}
