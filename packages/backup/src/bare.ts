import { advertisedRefs, type RefsState, sortedRefs } from '@git-forge/core'

export const bareRepositoryFiles = (stored: RefsState, packs: readonly string[]): Readonly<Record<string, string>> => {
  const state = advertisedRefs(stored)
  return {
    HEAD: `ref: ${state.head}\n`,
    config: '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n',
    'packed-refs': sortedRefs(state)
      .map(([name, id]) => `${id} ${name}\n`)
      .join(''),
    'objects/info/packs': `${packs.map((name) => `P ${name}\n`).join('')}\n`,
  }
}
