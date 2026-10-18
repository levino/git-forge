import { base64UrlEncode, randomBytes } from './encoding.ts'

export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

export const DEVICE_CODE_TTL_SECONDS = 15 * 60

export const DEVICE_POLL_INTERVAL_SECONDS = 5

export const DEVICE_SLOW_DOWN_SECONDS = 5

export const DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

export const DEVICE_CLIENT_ID = 'git-forge-cli'

export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export const USER_CODE_LENGTH = 8

export const generateUserCode = (): string => {
  const limit = 256 - (256 % USER_CODE_ALPHABET.length)
  let code = ''
  while (code.length < USER_CODE_LENGTH) {
    for (const byte of randomBytes(16)) {
      if (byte < limit && code.length < USER_CODE_LENGTH) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export const normalizeUserCode = (input: string): string | null => {
  const letters = input.toUpperCase().replace(/[\s-]/g, '')
  if (letters.length !== USER_CODE_LENGTH) return null
  for (const letter of letters) if (!USER_CODE_ALPHABET.includes(letter)) return null
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

export const generateDeviceCode = (): string => `gfd_${base64UrlEncode(randomBytes(32))}`

export const DEVICE_STATUSES = ['pending', 'approved', 'denied', 'consumed'] as const

export type DeviceStatus = (typeof DEVICE_STATUSES)[number]

export type DevicePollState = {
  readonly status: DeviceStatus
  readonly expiresAt: number
  readonly intervalSeconds: number
  readonly lastPolledAt: number | null
}

export type DevicePollOutcome =
  | { readonly kind: 'expired_token' }
  | { readonly kind: 'access_denied' }
  | { readonly kind: 'slow_down'; readonly intervalSeconds: number }
  | { readonly kind: 'authorization_pending' }
  | { readonly kind: 'approved' }

export const devicePollOutcome = (state: DevicePollState, now: number): DevicePollOutcome => {
  if (state.status === 'consumed' || state.expiresAt <= now) return { kind: 'expired_token' }
  if (state.status === 'denied') return { kind: 'access_denied' }
  if (state.lastPolledAt !== null && now - state.lastPolledAt < state.intervalSeconds * 1000) {
    return { kind: 'slow_down', intervalSeconds: state.intervalSeconds + DEVICE_SLOW_DOWN_SECONDS }
  }
  return state.status === 'approved' ? { kind: 'approved' } : { kind: 'authorization_pending' }
}
