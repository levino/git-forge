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

export type DeliveredJob = {
  readonly requestId: number
  readonly jobId: string
  readonly jobDisplayName: string
  readonly runtimeToken: string
  readonly planPath: (area: string) => string
  readonly message: Record<string, any>
}

export class FakeRunner {
  private constructor(
    readonly baseUrl: string,
    readonly servicePath: string,
    readonly token: string,
    readonly sessionId: string,
  ) {}

  static async connect(baseUrl: string, servicePath: string, encodedJitConfig: string): Promise<FakeRunner> {
    const config = decodeConfig(encodedJitConfig)
    const response = await exchangeToken(config)
    if (response.status !== 200) throw new Error(`token exchange failed: ${response.status}`)
    const { access_token: token } = (await response.json()) as { access_token: string }
    const session = (await (
      await fetch(`${baseUrl}${servicePath}/_apis/v1/AgentSession/1`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ownerName: 'fake', agent: { id: config['.runner']['AgentId'] } }),
      })
    ).json()) as { sessionId: string }
    return new FakeRunner(baseUrl, servicePath, token, session.sessionId)
  }

  async poll(): Promise<{ status: number; messageId?: number; messageType?: string; body?: any }> {
    const response = await fetch(`${this.baseUrl}${this.servicePath}/_apis/v1/Message/1?sessionId=${this.sessionId}`, { headers: { Authorization: `Bearer ${this.token}` } })
    if (response.status !== 200) return { status: response.status }
    const message = (await response.json()) as { messageId: number; messageType: string; body: string }
    await fetch(`${this.baseUrl}${this.servicePath}/_apis/v1/Message/1/${message.messageId}?sessionId=${this.sessionId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } })
    return { status: 200, messageId: message.messageId, messageType: message.messageType, body: JSON.parse(message.body) }
  }

  async take(): Promise<DeliveredJob> {
    const message = await this.poll()
    if (message.messageType !== 'PipelineAgentJobRequest') throw new Error(`expected a job, got ${message.status} ${message.messageType}`)
    const job = message.body
    const plan = `${this.baseUrl}${this.servicePath}/_apis/v1/%s/${job.plan.scopeIdentifier}/${job.plan.planType}/${job.plan.planId}`
    return {
      requestId: job.requestId,
      jobId: job.jobId,
      jobDisplayName: job.jobDisplayName,
      runtimeToken: job.resources.endpoints[0].authorization.parameters.AccessToken,
      planPath: (area) => plan.replace('%s', area),
      message: job,
    }
  }

  async renew(job: DeliveredJob): Promise<number> {
    const response = await fetch(`${this.baseUrl}${this.servicePath}/_apis/v1/AgentRequest/1/${job.requestId}?lockToken=00000000-0000-0000-0000-000000000000`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: job.requestId }),
    })
    return response.status
  }

  async finish(job: DeliveredJob, result: string, outputs: Record<string, string> = {}): Promise<number> {
    const response = await fetch(job.planPath('FinishJob'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${job.runtimeToken}` },
      body: JSON.stringify({
        name: 'JobCompleted',
        jobId: job.jobId,
        requestId: job.requestId,
        result,
        outputs: Object.fromEntries(Object.entries(outputs).map(([name, value]) => [name, { value }])),
      }),
    })
    return response.status
  }

  async run(result = 'succeeded', outputs: Record<string, string> = {}): Promise<DeliveredJob> {
    const job = await this.take()
    await this.renew(job)
    await this.finish(job, result, outputs)
    return job
  }
}
