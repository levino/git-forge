import { fromUtf8, utf8 } from '@git-forge/accounts'
import type { RsaParameters } from './keys.ts'

export type RunnerSettings = {
  readonly AgentId: number
  readonly AgentName: string
  readonly PoolId: number
  readonly PoolName: string
  readonly ServerUrl: string
  readonly GitHubUrl: string
  readonly WorkFolder: string
  readonly Ephemeral: boolean
  readonly DisableUpdate: boolean
}

export type CredentialFile = {
  readonly Scheme: 'OAuth'
  readonly Data: {
    readonly clientId: string
    readonly authorizationUrl: string
    readonly requireFipsCryptography: 'False'
  }
}

export type JitConfig = {
  readonly runner: RunnerSettings
  readonly credentials: CredentialFile
  readonly rsaParameters: RsaParameters
}

export const JIT_FILES = { runner: '.runner', credentials: '.credentials', rsaParameters: '.credentials_rsaparams' } as const

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

const encodeFile = (value: unknown): string => encodeBase64(utf8(JSON.stringify(value)))

export const encodeJitConfig = (config: JitConfig): string =>
  encodeFile({
    [JIT_FILES.runner]: encodeFile(config.runner),
    [JIT_FILES.credentials]: encodeFile(config.credentials),
    [JIT_FILES.rsaParameters]: encodeFile(config.rsaParameters),
  })

export const decodeJitConfig = (encoded: string): Record<string, unknown> => {
  const files = JSON.parse(fromUtf8(decodeBase64(encoded))) as Record<string, string>
  return Object.fromEntries(Object.entries(files).map(([name, content]) => [name, JSON.parse(fromUtf8(decodeBase64(content)))]))
}
