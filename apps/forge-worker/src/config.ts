import { type CacheLimits, DEFAULT_ARTIFACT_RETENTION_DAYS, DEFAULT_CACHE_LIMITS, type Es256PrivateJwk, type IdTokenKey, idTokenKeyFromInstanceKey, importEs256Key, importSecretsKey, type SecretsKey } from '@git-forge/actions'
import {
  BreakGlassError,
  DEFAULT_GROUPS_CLAIM,
  DEFAULT_OIDC_SCOPES,
  importSigningKey,
  isMembershipSource,
  type MembershipSource,
  normalizeIssuer,
  normalizeOidcIssuer,
  type OidcClientConfig,
  OidcError,
  type OkpPublicJwk,
  parseBreakGlassPublicKey,
  type PrivateJwk,
  type SigningKey,
} from '@git-forge/accounts'
import { PagesConfigError, type PagesHosts, parsePagesHosts } from '@git-forge/pages'

export { generateEs256Key, importEs256Key } from '@git-forge/actions'

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
  readonly ACTIONS_SECRETS_KEY?: string
  readonly ACTIONS_REPOSITORIES?: string
  readonly ACTIONS_GITHUB_FALLBACK?: string
  readonly ACTIONS_OIDC_KEY?: string
  readonly ACTIONS_ID_TOKENS?: string
  readonly ACTIONS_ARTIFACT_RETENTION_DAYS?: string
  readonly ACTIONS_CACHE_LIMIT_BYTES?: string
  readonly ACTIONS_CACHE_UNUSED_DAYS?: string
  readonly ACTIONS_CACHE_MAX_DAYS?: string
  readonly ACTIONS_RUNNER_LABELS?: string
  readonly MIRROR_DEEP_CHECK_DAYS?: string
  readonly MIRROR_UNIT_BYTES?: string
  readonly UI?: string
  readonly ALLOW_INSECURE_WEBHOOKS?: string
  readonly ALLOW_PRIVATE_REMOTES?: string
  readonly EMAIL_PROVIDER?: string
  readonly EMAIL_FROM?: string
  readonly SES_REGION?: string
  readonly SES_ACCESS_KEY_ID?: string
  readonly SES_SECRET_ACCESS_KEY?: string
  readonly SES_ENDPOINT?: string
  readonly SES_CONFIGURATION_SET?: string
  readonly OIDC_ISSUER?: string
  readonly OIDC_CLIENT_ID?: string
  readonly OIDC_CLIENT_SECRET?: string
  readonly OIDC_NAME?: string
  readonly OIDC_SCOPES?: string
  readonly SELF_SIGNUP?: string
  readonly PASSKEYS?: string
  readonly MEMBERSHIP_SOURCE?: string
  readonly OIDC_GROUPS_CLAIM?: string
  readonly BREAK_GLASS_PUBLIC_KEY?: string
  readonly R2_S3_ENDPOINT?: string
  readonly R2_BUCKET_NAME?: string
  readonly R2_ACCESS_KEY_ID?: string
  readonly R2_SECRET_ACCESS_KEY?: string
  readonly PAGES_HOST?: string
  readonly PAGES_DOMAINS?: string
  readonly PAGES_MAX_AGE?: string
  readonly LFS_PUBLISH_PREFIX?: string
}

export type R2SigningSettings = {
  readonly endpoint: string
  readonly bucket: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export type PagesSettings = {
  readonly hosts: PagesHosts | null
  readonly maxAgeSeconds: number
}

export type LoginSettings = {
  readonly oidc: OidcClientConfig | undefined
  readonly selfSignup: boolean
  readonly breakGlassKey: OkpPublicJwk | undefined
  readonly passkeys?: boolean
  readonly membershipSource?: MembershipSource
  readonly groupsClaim?: string
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
  readonly allowPrivateRemotes?: boolean
  readonly login?: LoginSettings
  readonly pages?: PagesSettings
}

export type EmailSettings =
  | { readonly provider: 'console'; readonly from: string }
  | { readonly provider: 'cloudflare'; readonly from: string }
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
  readonly secretsKey: string | undefined
  readonly repositories: Readonly<Record<string, string>>
  readonly githubFallback: string | null
  readonly oidcKey: string | undefined
  readonly idTokens: boolean
  readonly artifactRetentionDays: number
  readonly cacheLimits: CacheLimits
  readonly runnerLabels: readonly string[] | undefined
}

export const ACTIONS_CRON = '*/5 * * * *'

const ACTION_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/(\*|[A-Za-z0-9][A-Za-z0-9._-]*)$/

export const parseActionRepositories = (value: string | undefined): Record<string, string> => {
  const text = present(value)
  if (!text) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigurationError('ACTIONS_REPOSITORIES must be a JSON object like {"actions/*": "mirrors/*"}')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ConfigurationError('ACTIONS_REPOSITORIES must be a JSON object like {"actions/*": "mirrors/*"}')
  for (const [pattern, target] of Object.entries(parsed)) {
    if (typeof target !== 'string' || !ACTION_REPOSITORY.test(pattern) || !ACTION_REPOSITORY.test(target) || (target.endsWith('/*') && !pattern.endsWith('/*'))) {
      throw new ConfigurationError(`ACTIONS_REPOSITORIES: invalid mapping ${pattern} -> ${String(target)}`)
    }
  }
  return parsed as Record<string, string>
}

export const parseGithubFallback = (value: string | undefined): string | null => {
  const text = present(value)
  if (!text || text === 'false') return null
  if (text === 'true') return 'https://api.github.com'
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') throw new Error('not https')
    return text.replace(/\/$/, '')
  } catch {
    throw new ConfigurationError('ACTIONS_GITHUB_FALLBACK must be true, false or an https API base URL')
  }
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

export const parseOidcSettings = (vars: ForgeVars): OidcClientConfig | undefined => {
  const issuer = present(vars.OIDC_ISSUER)
  const clientId = present(vars.OIDC_CLIENT_ID)
  if (!issuer && !clientId) return undefined
  if (!issuer || !clientId) throw new ConfigurationError('OIDC_ISSUER and OIDC_CLIENT_ID must be set together')
  let normalized: string
  try {
    normalized = normalizeOidcIssuer(issuer)
  } catch (error) {
    if (error instanceof OidcError) throw new ConfigurationError(error.message)
    throw error
  }
  const scopes = present(vars.OIDC_SCOPES)?.split(/\s+/) ?? [...DEFAULT_OIDC_SCOPES]
  return { issuer: normalized, clientId, clientSecret: present(vars.OIDC_CLIENT_SECRET), scopes, name: present(vars.OIDC_NAME) ?? 'single sign-on' }
}

export const parseLoginSettings = (vars: ForgeVars): LoginSettings => {
  const breakGlass = present(vars.BREAK_GLASS_PUBLIC_KEY)
  let breakGlassKey: OkpPublicJwk | undefined
  try {
    breakGlassKey = breakGlass ? parseBreakGlassPublicKey(breakGlass) : undefined
  } catch (error) {
    if (error instanceof BreakGlassError) throw new ConfigurationError(error.message)
    throw error
  }
  const membershipSource = present(vars.MEMBERSHIP_SOURCE) ?? 'forge'
  if (!isMembershipSource(membershipSource)) throw new ConfigurationError('MEMBERSHIP_SOURCE must be forge or idp')
  return {
    oidc: parseOidcSettings(vars),
    selfSignup: vars.SELF_SIGNUP === 'true',
    breakGlassKey,
    passkeys: present(vars.PASSKEYS) !== 'false',
    membershipSource,
    groupsClaim: present(vars.OIDC_GROUPS_CLAIM) ?? DEFAULT_GROUPS_CLAIM,
  }
}

export const DEFAULT_PAGES_MAX_AGE = 60

export const parsePagesSettings = (vars: ForgeVars): PagesSettings => {
  try {
    return { hosts: parsePagesHosts(vars.PAGES_HOST, vars.PAGES_DOMAINS), maxAgeSeconds: positiveInteger(vars.PAGES_MAX_AGE, DEFAULT_PAGES_MAX_AGE, true) }
  } catch (error) {
    if (error instanceof PagesConfigError) throw new ConfigurationError(error.message)
    throw error
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
    allowPrivateRemotes: vars.ALLOW_PRIVATE_REMOTES === 'true',
    login: parseLoginSettings(vars),
    pages: parsePagesSettings(vars),
  }
}

export const parseR2Signing = (vars: ForgeVars): R2SigningSettings | undefined => {
  const endpoint = present(vars.R2_S3_ENDPOINT)
  const bucket = present(vars.R2_BUCKET_NAME)
  const accessKeyId = present(vars.R2_ACCESS_KEY_ID)
  const secretAccessKey = present(vars.R2_SECRET_ACCESS_KEY)
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return undefined
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new ConfigurationError('presigned R2 uploads need R2_S3_ENDPOINT, R2_BUCKET_NAME, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY')
  }
  return { endpoint, bucket, accessKeyId, secretAccessKey }
}

const hostOf = (url: string | undefined): string | undefined => (url && URL.canParse(url) ? new URL(url).hostname : undefined)

export const parseEmailSettings = (vars: ForgeVars, sendEmailBinding = false): EmailSettings | undefined => {
  const explicit = present(vars.EMAIL_PROVIDER)
  const provider = explicit ?? (sendEmailBinding ? 'cloudflare' : undefined)
  if (provider === undefined || provider === 'none') return undefined
  const host = provider === 'cloudflare' ? hostOf(present(vars.PUBLIC_URL)) : undefined
  const from = present(vars.EMAIL_FROM) ?? (host ? `Forge <forge@${host}>` : undefined)
  if (!from && !explicit) return undefined
  if (!from) throw new ConfigurationError('EMAIL_FROM is required when EMAIL_PROVIDER is set')
  if (provider === 'console') return { provider, from }
  if (provider === 'cloudflare') {
    if (!sendEmailBinding) throw new ConfigurationError('EMAIL_PROVIDER=cloudflare needs a send_email binding named EMAIL')
    return { provider, from }
  }
  if (provider !== 'ses') throw new ConfigurationError('EMAIL_PROVIDER must be none, console, cloudflare or ses')
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
  return {
    instanceId: instanceId ?? DEFAULT_ACTIONS_INSTANCE_ID,
    secrets: parseActionsSecrets(vars.ACTIONS_SECRETS),
    secretsKey: present(vars.ACTIONS_SECRETS_KEY),
    repositories: parseActionRepositories(vars.ACTIONS_REPOSITORIES),
    githubFallback: parseGithubFallback(vars.ACTIONS_GITHUB_FALLBACK),
    oidcKey: present(vars.ACTIONS_OIDC_KEY),
    idTokens: vars.ACTIONS_ID_TOKENS !== 'false',
    artifactRetentionDays: positiveInteger(vars.ACTIONS_ARTIFACT_RETENTION_DAYS, DEFAULT_ARTIFACT_RETENTION_DAYS),
    cacheLimits: {
      ...DEFAULT_CACHE_LIMITS,
      repositoryBytes: positiveInteger(vars.ACTIONS_CACHE_LIMIT_BYTES, DEFAULT_CACHE_LIMITS.repositoryBytes),
      entryBytes: Math.min(DEFAULT_CACHE_LIMITS.entryBytes, positiveInteger(vars.ACTIONS_CACHE_LIMIT_BYTES, DEFAULT_CACHE_LIMITS.repositoryBytes)),
      unusedDays: positiveInteger(vars.ACTIONS_CACHE_UNUSED_DAYS, DEFAULT_CACHE_LIMITS.unusedDays),
      maxDays: positiveInteger(vars.ACTIONS_CACHE_MAX_DAYS, DEFAULT_CACHE_LIMITS.maxDays),
    },
    runnerLabels: present(vars.ACTIONS_RUNNER_LABELS)
      ?.split(',')
      .map((label) => label.trim())
      .filter((label) => label !== ''),
  }
}

export const loadIdTokenKeys = async (settings: ActionsSettings | undefined, instanceKey: SigningKey | undefined): Promise<IdTokenKey[]> => {
  if (!settings?.idTokens) return []
  if (!settings.oidcKey) return instanceKey ? [idTokenKeyFromInstanceKey(instanceKey)] : []
  let jwk: Es256PrivateJwk
  try {
    jwk = JSON.parse(settings.oidcKey) as Es256PrivateJwk
  } catch {
    throw new ConfigurationError('ACTIONS_OIDC_KEY must be a P-256 private JWK in JSON')
  }
  try {
    return [await importEs256Key(jwk), ...(instanceKey ? [idTokenKeyFromInstanceKey(instanceKey)] : [])]
  } catch (error) {
    throw new ConfigurationError(`ACTIONS_OIDC_KEY is not a usable P-256 private JWK: ${(error as Error).message}`)
  }
}

export const loadSecretsKey = async (settings: ActionsSettings | undefined, vars?: ForgeVars): Promise<SecretsKey | undefined> => {
  const encoded = settings?.secretsKey ?? present(vars?.ACTIONS_SECRETS_KEY)
  if (!encoded) return undefined
  try {
    return await importSecretsKey(encoded)
  } catch (error) {
    throw new ConfigurationError(`ACTIONS_SECRETS_KEY: ${(error as Error).message}`)
  }
}

export const uiEnabled = (vars: ForgeVars): boolean => vars.UI?.trim().toLowerCase() !== 'false'
