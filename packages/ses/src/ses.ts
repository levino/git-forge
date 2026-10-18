import { type EmailMessage, EmailRejectedError, type EmailSender, type SentEmail, validateEmail } from '@git-forge/core'
import { AwsV4Signer } from 'aws4fetch'

export type SesConfig = {
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly from: string
  readonly endpoint?: string
  readonly configurationSet?: string
  readonly fetch?: typeof fetch
}

export class SesError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message)
    this.name = 'SesError'
  }
}

const RETRYABLE_CODES = new Set(['TooManyRequestsException', 'LimitExceededException', 'InternalFailure', 'ServiceUnavailable', 'ThrottlingException'])

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/

export const sesEndpoint = (config: Pick<SesConfig, 'region' | 'endpoint'>): string => {
  if (config.endpoint) return config.endpoint.replace(/\/+$/, '')
  if (!REGION.test(config.region)) throw new Error(`invalid AWS region ${config.region}`)
  return `https://email.${config.region}.amazonaws.com`
}

const content = (data: string) => ({ Data: data, Charset: 'UTF-8' })

export const sendEmailRequestBody = (message: EmailMessage, config: Pick<SesConfig, 'from' | 'configurationSet'>) => ({
  FromEmailAddress: message.from ?? config.from,
  Destination: { ToAddresses: [...message.to] },
  ...(message.replyTo && message.replyTo.length > 0 ? { ReplyToAddresses: [...message.replyTo] } : {}),
  Content: {
    Simple: {
      Subject: content(message.subject),
      Body: { Text: content(message.text), ...(message.html !== undefined ? { Html: content(message.html) } : {}) },
      ...(message.headers && Object.keys(message.headers).length > 0
        ? { Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })) }
        : {}),
    },
  },
  ...(config.configurationSet ? { ConfigurationSetName: config.configurationSet } : {}),
})

const errorOf = async (response: Response): Promise<SesError> => {
  const text = (await response.text()).slice(0, 2000)
  let code = response.headers.get('x-amzn-ErrorType')?.split(':')[0] ?? undefined
  let message = text
  try {
    const parsed = JSON.parse(text) as { message?: string; Message?: string; __type?: string }
    message = parsed.message ?? parsed.Message ?? text
    code ??= parsed.__type?.split('#').pop()
  } catch {}
  return new SesError(response.status, code, `SES SendEmail failed with HTTP ${response.status}${code ? ` ${code}` : ''}: ${message}`)
}

export const createSesEmailSender = (config: SesConfig): EmailSender => {
  const endpoint = sesEndpoint(config)
  const fetcher = config.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  return {
    send: async (message): Promise<SentEmail> => {
      const problem = validateEmail(message, config.from)
      if (problem) throw new EmailRejectedError(problem)
      const signer = new AwsV4Signer({
        url: `${endpoint}/v2/email/outbound-emails`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendEmailRequestBody(message, config)),
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
        service: 'ses',
        region: config.region,
      })
      const signed = await signer.sign()
      const response = await fetcher(signed.url, { method: signed.method, headers: signed.headers, body: signed.body ?? null })
      if (!response.ok) {
        const error = await errorOf(response)
        const retryable = response.status >= 500 || response.status === 429 || (error.code !== undefined && RETRYABLE_CODES.has(error.code))
        if (retryable) throw error
        throw new EmailRejectedError(error.message, response.status)
      }
      const body = (await response.json()) as { MessageId?: unknown }
      if (typeof body.MessageId !== 'string') throw new SesError(response.status, undefined, 'SES SendEmail answered without MessageId')
      return { id: body.MessageId }
    },
  }
}
