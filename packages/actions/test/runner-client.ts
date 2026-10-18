import { base64UrlEncode, utf8 } from '@git-forge/accounts'
import { decodeJitConfig, type RsaParameters } from '../src/index.ts'

export type DecodedJitConfig = {
  readonly '.runner': Record<string, unknown>
  readonly '.credentials': { readonly Data: Record<string, string> }
  readonly '.credentials_rsaparams': RsaParameters
}

export const decodeConfig = (encoded: string): DecodedJitConfig => decodeJitConfig(encoded) as DecodedJitConfig

const toBase64Url = (base64: string) => base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const signAssertion = async (params: RsaParameters, claims: Record<string, unknown>): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'RSA',
      n: toBase64Url(params.modulus),
      e: toBase64Url(params.exponent),
      d: toBase64Url(params.d),
      p: toBase64Url(params.p),
      q: toBase64Url(params.q),
      dp: toBase64Url(params.dp),
      dq: toBase64Url(params.dq),
      qi: toBase64Url(params.inverseQ),
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const input = `${base64UrlEncode(utf8(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64UrlEncode(utf8(JSON.stringify(claims)))}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf8(input)))
  return `${input}.${base64UrlEncode(signature)}`
}

export const exchangeToken = async (config: DecodedJitConfig): Promise<Response> => {
  const now = Math.floor(Date.now() / 1000)
  const clientId = config['.credentials'].Data['clientId']!
  const authorizationUrl = config['.credentials'].Data['authorizationUrl']!
  const assertion = await signAssertion(config['.credentials_rsaparams'], { iss: clientId, sub: clientId, aud: authorizationUrl, jti: crypto.randomUUID(), nbf: now - 30, iat: now - 30, exp: now + 300 })
  return fetch(authorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion }),
  })
}
