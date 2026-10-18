import { EmailRejectedError } from '@git-forge/core'
import { afterEach, describe, expect, it } from 'vitest'
import { composeMessage, createSmtpEmailSender, dotStuff, encodeWords, formatMailbox, SmtpError } from '../src/index.ts'
import { type FakeSmtpOptions, type FakeSmtpServer, selfSignedCertificate, startFakeSmtp } from './fake-smtp.ts'

const certificate = selfSignedCertificate()
const servers: FakeSmtpServer[] = []

const start = async (options: Omit<FakeSmtpOptions, 'certificate'>) => {
  const server = await startFakeSmtp({ ...options, certificate })
  servers.push(server)
  return server
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const decodeParts = (data: string): string[] =>
  [...data.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$|$)/g)].map((match) =>
    Buffer.from(match[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'),
  )

const message = { to: ['ada@example.org'], subject: 'Grüße from the forge', text: 'Hello\n.dot line\nbye', html: '<p>Hello</p>', headers: { 'List-Unsubscribe': '<https://forge.example/unsubscribe>' } }

describe('SMTP email sender', () => {
  it('sends over STARTTLS with AUTH PLAIN', async () => {
    const server = await start({ mode: 'starttls', mechanisms: ['PLAIN', 'LOGIN'], users: { forge: 's3cret' } })
    const sender = createSmtpEmailSender({ host: '127.0.0.1', port: server.port, username: 'forge', password: 's3cret', from: 'Forge <forge@example.org>', helo: 'pi.example.org', tls: { ca: certificate.cert } })
    const sent = await sender.send(message)
    expect(sent.id).toMatch(/^<[0-9a-f-]+@example\.org>$/)
    expect(server.messages).toHaveLength(1)
    const [received] = server.messages
    expect(received).toMatchObject({ from: 'forge@example.org', recipients: ['ada@example.org'], secure: true, auth: { mechanism: 'PLAIN', username: 'forge', password: 's3cret' } })
    expect(received!.data).toContain('From: Forge <forge@example.org>\r\n')
    expect(received!.data).toContain('Subject: =?UTF-8?B?R3LDvMOfZSBmcm9tIHRoZSBmb3JnZQ==?=\r\n')
    expect(received!.data).toContain(`Message-ID: ${sent.id}\r\n`)
    expect(received!.data).toContain('List-Unsubscribe: <https://forge.example/unsubscribe>\r\n')
    expect(received!.data).toMatch(/Content-Type: multipart\/alternative; boundary="=_[0-9a-f-]+"/)
    expect(decodeParts(received!.data)).toEqual(['Hello\r\n.dot line\r\nbye', '<p>Hello</p>'])
    expect(server.transcripts[0]!.filter((line) => line.startsWith('C: '))).toEqual([
      'C: EHLO pi.example.org',
      'C: STARTTLS',
      'C: EHLO pi.example.org',
      expect.stringMatching(/^C: AUTH PLAIN /),
      'C: MAIL FROM:<forge@example.org>',
      'C: RCPT TO:<ada@example.org>',
      'C: DATA',
      'C: QUIT',
    ])
  })

  it('sends over implicit TLS with AUTH LOGIN', async () => {
    const server = await start({ mode: 'tls', mechanisms: ['LOGIN'], users: { forge: 'pw' } })
    const sender = createSmtpEmailSender({ host: '127.0.0.1', port: server.port, security: 'tls', username: 'forge', password: 'pw', from: 'forge@example.org', tls: { ca: certificate.cert } })
    await sender.send({ to: ['ada@example.org', 'bob@example.org'], subject: 'Plain', text: 'only text' })
    const [received] = server.messages
    expect(received).toMatchObject({ recipients: ['ada@example.org', 'bob@example.org'], secure: true, auth: { mechanism: 'LOGIN', username: 'forge', password: 'pw' } })
    expect(received!.data).toContain('Content-Type: text/plain; charset=utf-8\r\n')
    expect(decodeParts(received!.data)).toEqual(['only text'])
  })

  it('sends without TLS or authentication to a local relay', async () => {
    const server = await start({ mode: 'none' })
    await createSmtpEmailSender({ host: '127.0.0.1', port: server.port, security: 'none', from: 'forge@example.org' }).send({ to: ['ada@example.org'], subject: 'Hi', text: 'x' })
    expect(server.messages[0]).toMatchObject({ secure: false, auth: null })
  })

  it('refuses a server without STARTTLS and an untrusted certificate', async () => {
    const plain = await start({ mode: 'starttls', offerStarttls: false })
    await expect(createSmtpEmailSender({ host: '127.0.0.1', port: plain.port, from: 'forge@example.org' }).send(message)).rejects.toThrow(/does not offer STARTTLS/)
    const untrusted = await start({ mode: 'starttls' })
    await expect(createSmtpEmailSender({ host: '127.0.0.1', port: untrusted.port, from: 'forge@example.org' }).send(message)).rejects.toThrow(SmtpError)
    expect(plain.messages).toHaveLength(0)
    expect(untrusted.messages).toHaveLength(0)
  })

  it('treats 5xx answers as permanent and 4xx answers as retryable', async () => {
    const server = await start({
      mode: 'tls',
      mechanisms: ['PLAIN'],
      users: { forge: 'pw' },
      rcpt: (address) => (address.startsWith('gone') ? '550 5.1.1 no such user' : address.startsWith('busy') ? '451 4.3.0 try later' : null),
    })
    const config = { host: '127.0.0.1', port: server.port, security: 'tls', username: 'forge', password: 'pw', from: 'forge@example.org', tls: { ca: certificate.cert } } as const
    const gone = createSmtpEmailSender(config).send({ to: ['gone@example.org'], subject: 's', text: 't' })
    await expect(gone).rejects.toBeInstanceOf(EmailRejectedError)
    await expect(gone).rejects.toMatchObject({ status: 550 })
    const busy = createSmtpEmailSender(config).send({ to: ['busy@example.org'], subject: 's', text: 't' })
    await expect(busy).rejects.toBeInstanceOf(SmtpError)
    await expect(busy).rejects.toMatchObject({ code: 451 })
    const wrong = createSmtpEmailSender({ ...config, password: 'nope' }).send({ to: ['ada@example.org'], subject: 's', text: 't' })
    await expect(wrong).rejects.toThrow(/535 .* to AUTH$/)
    expect(server.messages).toHaveLength(0)
  })

  it('validates messages and configuration before connecting', async () => {
    const sender = createSmtpEmailSender({ host: '127.0.0.1', port: 1, from: 'forge@example.org' })
    await expect(sender.send({ to: [], subject: 's', text: 't' })).rejects.toThrow(EmailRejectedError)
    await expect(sender.send({ to: ['ada@example.org'], subject: 'a\r\nBcc: x@example.org', text: 't' })).rejects.toThrow(EmailRejectedError)
    expect(() => createSmtpEmailSender({ host: 'h', security: 'none', username: 'u', password: 'p', from: 'forge@example.org' })).toThrow(/need TLS/)
    expect(() => createSmtpEmailSender({ host: 'h', username: 'u', from: 'forge@example.org' })).toThrow(/username and a password/)
    await expect(sender.send({ to: ['ada@example.org'], subject: 's', text: 't' })).rejects.toThrow(/cannot connect to SMTP server 127\.0\.0\.1:1/)
  })
})

describe('message composition', () => {
  it('encodes headers and dot-stuffs lines', () => {
    expect(encodeWords('plain')).toBe('plain')
    const long = encodeWords('ä'.repeat(40))
    expect(long.split('\r\n ').every((word) => word.length <= 75)).toBe(true)
    expect(formatMailbox('Forge <f@example.org>')).toBe('Forge <f@example.org>')
    expect(formatMailbox('"Forge, Inc." <f@example.org>')).toBe('"Forge, Inc." <f@example.org>')
    expect(formatMailbox('Förge <f@example.org>')).toBe('=?UTF-8?B?RsO2cmdl?= <f@example.org>')
    expect(dotStuff('.a\r\nb\r\n.c\r\n')).toBe('..a\r\nb\r\n..c\r\n')
    const composed = composeMessage({ to: ['a@example.org'], replyTo: ['r@example.org'], subject: 's', text: 't' }, 'f@example.org', { date: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), id: '<x@example.org>' })
    expect(composed.data.split('\r\n').slice(0, 7)).toEqual([
      'From: f@example.org',
      'To: a@example.org',
      'Reply-To: r@example.org',
      'Subject: s',
      'Date: Fri, 02 Jan 2026 03:04:05 +0000',
      'Message-ID: <x@example.org>',
      'MIME-Version: 1.0',
    ])
  })
})
