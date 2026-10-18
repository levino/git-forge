import { fromUtf8, sha256Hex, utf8 } from '@git-forge/accounts'

export type Outbound = (input: string, init?: RequestInit) => Promise<Response>

export const RELEASE_REPOSITORY = 'levino/git-forge'

export const RELEASE_CHECK_MS = 6 * 60 * 60 * 1000

export const INSTANCE_CONFIG_PATH = 'wrangler.toml'

export type Release = { readonly version: string; readonly url: string; readonly sha256: string }

export type ReleaseCheck = { readonly checkedAt: number; readonly latest: Release | null; readonly error?: string }

export type Pin = { readonly version: string; readonly sha256: string }

export class UpdateError extends Error {}

export const parseVersion = (value: string): readonly number[] | null => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  return match ? match.slice(1).map(Number) : null
}

export const isNewer = (candidate: string, running: string): boolean => {
  const [a, b] = [parseVersion(candidate), parseVersion(running)]
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!
  return false
}

const PIN = /V=([0-9A-Za-z.+-]+) S=([0-9a-f]{64})/g

export const readPin = (config: string): Pin | null => {
  const pins = [...config.matchAll(PIN)]
  return pins.length === 1 ? { version: pins[0]![1]!, sha256: pins[0]![2]! } : null
}

export const repin = (config: string, pin: Pin): string => {
  if (!readPin(config)) throw new UpdateError(`${INSTANCE_CONFIG_PATH} must contain exactly one V=<version> S=<sha256> pin`)
  if (!parseVersion(pin.version) || !/^[0-9a-f]{64}$/.test(pin.sha256)) throw new UpdateError('invalid pin')
  return config.replace(PIN, `V=${pin.version} S=${pin.sha256}`)
}

const github = (token?: string): Record<string, string> => ({
  Accept: 'application/vnd.github+json',
  'User-Agent': 'git-forge',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
})

const failure = async (response: Response, what: string): Promise<UpdateError> => {
  const body = (await response.json().catch(() => null)) as { message?: string } | null
  return new UpdateError(`${what}: GitHub answered ${response.status}${body?.message ? ` (${body.message})` : ''}`)
}

export const releaseChecksum = async (fetch: Outbound, version: string): Promise<string> => {
  const response = await fetch(`https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/SHA256SUMS`, { headers: { 'User-Agent': 'git-forge' } })
  if (!response.ok) throw await failure(response, 'SHA256SUMS')
  return sha256Hex(new Uint8Array(await response.arrayBuffer()))
}

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export const INSTANCE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type InstanceRepository = { readonly repository: string; readonly token: string }

export const commitPin = async (fetch: Outbound, target: InstanceRepository, pin: Pin): Promise<{ readonly commitUrl: string; readonly previous: Pin | null }> => {
  const url = `https://api.github.com/repos/${target.repository}/contents/${INSTANCE_CONFIG_PATH}`
  const current = await fetch(url, { headers: github(target.token) })
  if (!current.ok) throw await failure(current, `reading ${target.repository}/${INSTANCE_CONFIG_PATH}`)
  const file = (await current.json()) as { content?: string; sha?: string }
  const text = fromUtf8(Uint8Array.from(atob(String(file.content ?? '').replace(/\s/g, '')), (char) => char.charCodeAt(0)))
  const previous = readPin(text)
  if (previous?.version === pin.version && previous.sha256 === pin.sha256) throw new UpdateError(`${target.repository} already pins ${pin.version}`)
  const updated = await fetch(url, {
    method: 'PUT',
    headers: { ...github(target.token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Update git-forge to ${pin.version}`, content: base64(utf8(repin(text, pin))), sha: file.sha }),
  })
  if (!updated.ok) throw await failure(updated, `committing to ${target.repository}`)
  const result = (await updated.json()) as { commit?: { html_url?: string } }
  return { commitUrl: String(result.commit?.html_url ?? ''), previous }
}
