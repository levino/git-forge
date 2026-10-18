import { importSigningKey, normalizeIssuer, type PrivateJwk, type SigningKey } from '@git-forge/accounts'

export type ForgeVars = {
  readonly PUBLIC_URL?: string
  readonly INSTANCE_KEY?: string
  readonly BOOTSTRAP_TOKEN?: string
  readonly MAX_PUSH_BYTES?: string
  readonly PACKFILE_URI_BASE?: string
  readonly COMPACT_MAX_BYTES?: string
  readonly MAX_LFS_OBJECT_BYTES?: string
  readonly MIRROR_INTERVAL_MINUTES?: string
  readonly ALLOW_INSECURE_FEDERATION?: string
  readonly ACTIONS?: string
  readonly ACTIONS_INSTANCE_ID?: string
  readonly ACTIONS_SECRETS?: string
  readonly MIRROR_DEEP_CHECK_DAYS?: string
  readonly MIRROR_UNIT_BYTES?: string
  readonly ALLOW_INSECURE_WEBHOOKS?: string
  readonly EMAIL_PROVIDER?: string
  readonly EMAIL_FROM?: string
  readonly SES_REGION?: string
  readonly SES_ACCESS_KEY_ID?: string
  readonly SES_SECRET_ACCESS_KEY?: string
  readonly SES_ENDPOINT?: string
  readonly SES_CONFIGURATION_SET?: string
}

export type ForgeSettings = {
  readonly publicUrl: string | undefined
  readonly instanceKey: SigningKey | undefined
  readonly bootstrapToken: string | undefined
  readonly maxPushBytes: number | undefined
  readonly packfileUriBase: string | undefined
  readonly compactMaxBytes: number
  readonly maxLfsObjectBytes: number
  readonly mirrorIntervalMinutes: number
  readonly allowInsecureFederation: boolean
  readonly deepCheckDays: number
  readonly mirrorUnitBytes: number
  readonly allowInsecureWebhooks?: boolean
}

export type EmailSettings =
  | { readonly provider: 'console'; readonly from: string }
  | {
      readonly provider: 'ses'
      readonly from: string
      readonly region: string
      readonly accessKeyId: string
      readonly secretAccessKey: string
      readonly endpoint?: string
      readonly configurationSet?: string
    }

export type ActionsSettings = {
  readonly instanceId: string
  readonly secrets: Readonly<Record<string, string>>
}

export const DEFAULT_ACTIONS_INSTANCE_ID = '00000000-0000-0000-0000-000000000000'

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const parseActionsSecrets = (value: string | undefined): Record<string, string> => {
  const text = present(value)
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigurationError('ACTIONS_SECRETS must be a JSON object of strings')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((item) => typeof item === 'string')) {
    throw new ConfigurationError('ACTIONS_SECRETS must be a JSON object of strings')
  }
  return parsed as Record<string, string>
}

export const DEFAULT_COMPACT_MAX_BYTES = 128 * 1024 * 1024

export const DEFAULT_MAX_LFS_OBJECT_BYTES = 100 * 1024 * 1024

export const DEFAULT_MIRROR_INTERVAL_MINUTES = 30

export const DEFAULT_DEEP_CHECK_DAYS = 30

export class ConfigurationError extends Error {}

const positiveInteger = (value: string | undefined, fallback: number, allowZero = false): number => {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && (parsed > 0 || (allowZero && parsed === 0)) ? parsed : fallback
}

const present = (value: string | undefined): string | undefined => (value === undefined || value.trim() === '' ? undefined : value.trim())

export const parseInstanceKey = async (value: string | undefined): Promise<SigningKey | undefined> => {
  const text = present(value)
  if (!text) return undefined
  let jwk: PrivateJwk
  try {
    jwk = JSON.parse(text) as PrivateJwk
  } catch {
    throw new ConfigurationError('INSTANCE_KEY must be an Ed25519 private JWK in JSON')
  }
  try {
    return await importSigningKey(jwk)
  } catch (error) {
    throw new ConfigurationError(`INSTANCE_KEY is not a usable Ed25519 private JWK: ${(error as Error).message}`)
  }
}

export const parseSettings = async (vars: ForgeVars): Promise<ForgeSettings> => {
  const publicUrl = present(vars.PUBLIC_URL)
  return {
    publicUrl: publicUrl ? normalizeIssuer(publicUrl) : undefined,
    instanceKey: await parseInstanceKey(vars.INSTANCE_KEY),
    bootstrapToken: present(vars.BOOTSTRAP_TOKEN),
    maxPushBytes: positiveInteger(vars.MAX_PUSH_BYTES, 0) || undefined,
    packfileUriBase: present(vars.PACKFILE_URI_BASE),
    compactMaxBytes: positiveInteger(vars.COMPACT_MAX_BYTES, DEFAULT_COMPACT_MAX_BYTES, true),
    maxLfsObjectBytes: positiveInteger(vars.MAX_LFS_OBJECT_BYTES, DEFAULT_MAX_LFS_OBJECT_BYTES),
    mirrorIntervalMinutes: positiveInteger(vars.MIRROR_INTERVAL_MINUTES, DEFAULT_MIRROR_INTERVAL_MINUTES, true),
    allowInsecureFederation: vars.ALLOW_INSECURE_FEDERATION === 'true',
    deepCheckDays: positiveInteger(vars.MIRROR_DEEP_CHECK_DAYS, DEFAULT_DEEP_CHECK_DAYS, true),
    mirrorUnitBytes: positiveInteger(vars.MIRROR_UNIT_BYTES, 0, true),
    allowInsecureWebhooks: vars.ALLOW_INSECURE_WEBHOOKS === 'true',
  }
}

export const parseEmailSettings = (vars: ForgeVars): EmailSettings | undefined => {
  const provider = present(vars.EMAIL_PROVIDER)
  if (provider === undefined || provider === 'none') return undefined
  const from = present(vars.EMAIL_FROM)
  if (!from) throw new ConfigurationError('EMAIL_FROM is required when EMAIL_PROVIDER is set')
  if (provider === 'console') return { provider, from }
  if (provider !== 'ses') throw new ConfigurationError('EMAIL_PROVIDER must be none, console or ses')
  const region = present(vars.SES_REGION)
  const accessKeyId = present(vars.SES_ACCESS_KEY_ID)
  const secretAccessKey = present(vars.SES_SECRET_ACCESS_KEY)
  if (!region || !accessKeyId || !secretAccessKey) throw new ConfigurationError('EMAIL_PROVIDER=ses needs SES_REGION, SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY')
  const endpoint = present(vars.SES_ENDPOINT)
  const configurationSet = present(vars.SES_CONFIGURATION_SET)
  return { provider, from, region, accessKeyId, secretAccessKey, ...(endpoint ? { endpoint } : {}), ...(configurationSet ? { configurationSet } : {}) }
}

export const parseActionsSettings = (vars: ForgeVars): ActionsSettings | undefined => {
  if (vars.ACTIONS !== 'true') return undefined
  const instanceId = present(vars.ACTIONS_INSTANCE_ID)
  if (instanceId !== undefined && !GUID.test(instanceId)) throw new ConfigurationError('ACTIONS_INSTANCE_ID must be a GUID')
  return { instanceId: instanceId ?? DEFAULT_ACTIONS_INSTANCE_ID, secrets: parseActionsSecrets(vars.ACTIONS_SECRETS) }
}
