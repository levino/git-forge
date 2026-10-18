import { EmailRejectedError } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { createSesEmailSender, SesError, sesEndpoint } from '../src/ses.ts'

type Captured = { url: string; method: string; headers: Headers; body: string }

const mockFetch = (respond: (request: Captured) => Response) => {
  const requests: Captured[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const captured = { url: request.url, method: request.method, headers: request.headers, body: await request.text() }
    requests.push(captured)
    return respond(captured)
  }) as typeof fetch
  return { requests, fetcher }
}

const config = { region: 'eu-central-1', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', from: 'Forge <forge@example.org>' }

describe('SES v2 email sender', () => {
  it('derives the regional endpoint and accepts an override', () => {
    expect(sesEndpoint({ region: 'eu-central-1' })).toBe('https://email.eu-central-1.amazonaws.com')
    expect(sesEndpoint({ region: 'eu-central-1', endpoint: 'http://127.0.0.1:9000/' })).toBe('http://127.0.0.1:9000')
    expect(() => sesEndpoint({ region: 'nowhere' })).toThrow('invalid AWS region')
  })

  it('signs a SendEmail request with SigV4 and returns the message id', async () => {
    const { requests, fetcher } = mockFetch(() => Response.json({ MessageId: 'ses-1' }))
    const sender = createSesEmailSender({ ...config, configurationSet: 'forge', fetch: fetcher })
    const sent = await sender.send({
      to: ['ada@example.org'],
      replyTo: ['noreply@example.org'],
      subject: 'Digest',
      text: 'two notifications',
      html: '<p>two</p>',
      headers: { 'List-Unsubscribe': '<https://forge.example.org/settings>' },
    })
    expect(sent).toEqual({ id: 'ses-1' })
    const [request] = requests
    expect(request!.url).toBe('https://email.eu-central-1.amazonaws.com/v2/email/outbound-emails')
    expect(request!.method).toBe('POST')
    expect(request!.headers.get('Authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/ses\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    )
    expect(request!.headers.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/)
    expect(JSON.parse(request!.body)).toEqual({
      FromEmailAddress: 'Forge <forge@example.org>',
      Destination: { ToAddresses: ['ada@example.org'] },
      ReplyToAddresses: ['noreply@example.org'],
      Content: {
        Simple: {
          Subject: { Data: 'Digest', Charset: 'UTF-8' },
          Body: { Text: { Data: 'two notifications', Charset: 'UTF-8' }, Html: { Data: '<p>two</p>', Charset: 'UTF-8' } },
          Headers: [{ Name: 'List-Unsubscribe', Value: '<https://forge.example.org/settings>' }],
        },
      },
      ConfigurationSetName: 'forge',
    })
  })

  it('treats rejected messages as permanent and throttling as retryable', async () => {
    const rejected = mockFetch(() => Response.json({ message: 'Email address is not verified.' }, { status: 400, headers: { 'x-amzn-ErrorType': 'MessageRejected:http://internal' } }))
    const error = await createSesEmailSender({ ...config, fetch: rejected.fetcher })
      .send({ to: ['ada@example.org'], subject: 's', text: 't' })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EmailRejectedError)
    expect((error as Error).message).toContain('MessageRejected')
    const throttled = mockFetch(() => Response.json({ message: 'Maximum sending rate exceeded.' }, { status: 429 }))
    await expect(createSesEmailSender({ ...config, fetch: throttled.fetcher }).send({ to: ['ada@example.org'], subject: 's', text: 't' })).rejects.toBeInstanceOf(SesError)
    const limited = mockFetch(() => Response.json({ __type: 'com.amazonaws#LimitExceededException', message: 'slow down' }, { status: 400 }))
    await expect(createSesEmailSender({ ...config, fetch: limited.fetcher }).send({ to: ['ada@example.org'], subject: 's', text: 't' })).rejects.toBeInstanceOf(SesError)
  })

  it('validates before sending anything', async () => {
    const { requests, fetcher } = mockFetch(() => Response.json({ MessageId: 'x' }))
    await expect(createSesEmailSender({ ...config, fetch: fetcher }).send({ to: ['not an address'], subject: 's', text: 't' })).rejects.toBeInstanceOf(EmailRejectedError)
    expect(requests).toHaveLength(0)
  })
})
