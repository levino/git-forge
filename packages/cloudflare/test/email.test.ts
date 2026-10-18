import { EmailRejectedError } from '@git-forge/core'
import { describe, expect, it } from 'vitest'
import { createCloudflareEmailSender } from '../src/email.ts'

const failing = (code: string | undefined): SendEmail => ({
  send: async () => {
    throw Object.assign(new Error('nope'), code ? { code } : {})
  },
})

describe('createCloudflareEmailSender', () => {
  it('sends the message through the binding', async () => {
    const sent: unknown[] = []
    const binding: SendEmail = {
      send: async (message: unknown) => {
        sent.push(message)
        return { messageId: 'cf-1' }
      },
    }
    const sender = createCloudflareEmailSender(binding, 'Forge <forge@example.org>')
    const message = { to: ['ada@example.org'], replyTo: ['ops@example.org'], subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', headers: { 'Auto-Submitted': 'auto-generated' } }
    expect(await sender.send(message)).toEqual({ id: 'cf-1' })
    expect(await sender.send({ from: 'bot@example.org', to: ['bob@example.org'], subject: 'Yo', text: 'x' })).toEqual({ id: 'cf-1' })
    expect(sent).toEqual([
      {
        from: { name: 'Forge', email: 'forge@example.org' },
        to: ['ada@example.org'],
        replyTo: 'ops@example.org',
        subject: 'Hi',
        text: 'Hello',
        html: '<p>Hello</p>',
        headers: { 'Auto-Submitted': 'auto-generated' },
      },
      { from: 'bot@example.org', to: ['bob@example.org'], subject: 'Yo', text: 'x' },
    ])
  })

  it('rejects permanently on validation and policy errors and rethrows transient ones', async () => {
    const message = { to: ['ada@example.org'], subject: 'Hi', text: 'Hello' }
    await expect(createCloudflareEmailSender(failing(undefined), 'forge@example.org').send({ ...message, to: [] })).rejects.toBeInstanceOf(EmailRejectedError)
    await expect(createCloudflareEmailSender(failing('E_RECIPIENT_NOT_ALLOWED'), 'forge@example.org').send(message)).rejects.toThrow(EmailRejectedError)
    await expect(createCloudflareEmailSender(failing('E_SENDER_NOT_VERIFIED'), 'forge@example.org').send(message)).rejects.toThrow('E_SENDER_NOT_VERIFIED')
    for (const code of ['E_RATE_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', undefined]) {
      const error = await createCloudflareEmailSender(failing(code), 'forge@example.org')
        .send(message)
        .catch((caught: unknown) => caught)
      expect(error).not.toBeInstanceOf(EmailRejectedError)
      expect(error).toBeInstanceOf(Error)
    }
  })
})
