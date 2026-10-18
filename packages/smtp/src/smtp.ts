import { isIP, connect as netConnect, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { type ConnectionOptions, connect as tlsConnect, type TLSSocket } from 'node:tls'
import { EmailRejectedError, type EmailSender, type SentEmail, validateEmail } from '@git-forge/core'
import { composeMessage, dotStuff } from './message.ts'

export type SmtpSecurity = 'starttls' | 'tls' | 'none'

export type SmtpConfig = {
  readonly host: string
  readonly port?: number
  readonly security?: SmtpSecurity
  readonly username?: string
  readonly password?: string
  readonly from: string
  readonly helo?: string
  readonly timeoutMs?: number
  readonly tls?: ConnectionOptions
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message)
    this.name = 'SmtpError'
  }
}

export const DEFAULT_SMTP_PORTS: Readonly<Record<SmtpSecurity, number>> = { starttls: 587, tls: 465, none: 25 }

export const DEFAULT_SMTP_TIMEOUT_MS = 30_000

type Reply = { readonly code: number; readonly lines: readonly string[] }

const replyText = (reply: Reply): string => `${reply.code} ${reply.lines.join(' ')}`.trim()

class Connection {
  private buffer = ''
  private lines: string[] = []
  private replies: Reply[] = []
  private waiter: { resolve: (reply: Reply) => void; reject: (error: Error) => void } | undefined
  private failure: Error | undefined
  private readonly onData = (chunk: Buffer) => this.receive(chunk.toString('utf8'))
  private readonly onError = (error: Error) => this.fail(new SmtpError(`SMTP connection failed: ${error.message}`))
  private readonly onClose = () => this.fail(new SmtpError('SMTP connection closed unexpectedly'))
  private readonly onTimeout = () => {
    this.fail(new SmtpError('SMTP server did not answer in time'))
    this.socket.destroy()
  }

  constructor(
    private socket: Socket,
    private readonly timeoutMs: number,
  ) {
    this.attach()
  }

  private attach() {
    this.socket.setTimeout(this.timeoutMs)
    this.socket.on('data', this.onData)
    this.socket.on('error', this.onError)
    this.socket.on('close', this.onClose)
    this.socket.on('timeout', this.onTimeout)
  }

  private detach() {
    this.socket.setTimeout(0)
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket.off('close', this.onClose)
    this.socket.off('timeout', this.onTimeout)
  }

  private receive(text: string) {
    this.buffer += text
    for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '')
      this.buffer = this.buffer.slice(end + 1)
      const match = /^(\d{3})([ -]?)(.*)$/.exec(line)
      if (!match) {
        this.fail(new SmtpError(`unexpected SMTP reply ${JSON.stringify(line.slice(0, 200))}`))
        return
      }
      this.lines.push(match[3]!)
      if (match[2] !== '-') {
        this.push({ code: Number(match[1]), lines: this.lines })
        this.lines = []
      }
    }
    if (this.buffer.length > 65536) this.fail(new SmtpError('SMTP reply line too long'))
  }

  private push(reply: Reply) {
    const waiter = this.waiter
    if (waiter) {
      this.waiter = undefined
      waiter.resolve(reply)
    } else this.replies.push(reply)
  }

  private fail(error: Error) {
    if (this.failure) return
    this.failure = error
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.reject(error)
  }

  read(): Promise<Reply> {
    const reply = this.replies.shift()
    if (reply) return Promise.resolve(reply)
    if (this.failure) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject }
    })
  }

  write(text: string) {
    if (this.failure) throw this.failure
    this.socket.write(text)
  }

  async command(line: string, expected: readonly number[], sensitive = false): Promise<Reply> {
    this.write(`${line}\r\n`)
    return this.expect(expected, sensitive ? 'AUTH' : line)
  }

  async expect(expected: readonly number[], context: string): Promise<Reply> {
    const reply = await this.read()
    if (expected.includes(reply.code)) return reply
    const text = `SMTP server answered ${replyText(reply)} to ${context}`
    if (reply.code >= 500) throw new EmailRejectedError(text, reply.code)
    throw new SmtpError(text, reply.code)
  }

  async upgrade(options: ConnectionOptions): Promise<void> {
    if (this.buffer !== '' || this.replies.length > 0) throw new SmtpError('SMTP server sent data before the TLS handshake')
    this.detach()
    const plain = this.socket
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect({ ...options, socket: plain }, () => resolve(socket))
      socket.once('error', (error) => reject(new SmtpError(`SMTP TLS handshake failed: ${error.message}`)))
    })
    this.socket = secure
    this.attach()
  }

  close() {
    this.detach()
    this.socket.on('error', () => undefined)
    this.socket.end()
    this.socket.destroy()
  }
}

const serverName = (host: string): ConnectionOptions => (isIP(host) === 0 ? { servername: host } : {})

const open = (config: SmtpConfig, security: SmtpSecurity, port: number, timeoutMs: number): Promise<Socket> =>
  new Promise((resolve, reject) => {
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(new SmtpError(`cannot connect to SMTP server ${config.host}:${port}: ${error.message}`))
    }
    const connected = () => {
      clearTimeout(timer)
      socket.off('error', fail)
      resolve(socket)
    }
    const socket =
      security === 'tls'
        ? tlsConnect({ ...serverName(config.host), ...config.tls, host: config.host, port }, connected)
        : netConnect({ host: config.host, port }, connected)
    const timer = setTimeout(() => socket.destroy(new Error('timeout')), timeoutMs)
    socket.once('error', fail)
  })

const extensions = (reply: Reply): Map<string, string> => {
  const map = new Map<string, string>()
  for (const line of reply.lines.slice(1)) {
    const [keyword, ...rest] = line.trim().split(/[\s=]+/)
    if (keyword) map.set(keyword.toUpperCase(), rest.join(' ').toUpperCase())
  }
  return map
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

const authenticate = async (connection: Connection, features: Map<string, string>, username: string, password: string): Promise<void> => {
  const mechanisms = (features.get('AUTH') ?? '').split(/\s+/)
  if (mechanisms.includes('PLAIN')) {
    await connection.command(`AUTH PLAIN ${b64(`\0${username}\0${password}`)}`, [235], true)
    return
  }
  if (mechanisms.includes('LOGIN')) {
    await connection.command('AUTH LOGIN', [334])
    await connection.command(b64(username), [334], true)
    await connection.command(b64(password), [235], true)
    return
  }
  throw new SmtpError(`SMTP server offers no supported AUTH mechanism (PLAIN, LOGIN); it offers ${features.get('AUTH') || 'none'}`)
}

export const createSmtpEmailSender = (config: SmtpConfig): EmailSender => {
  const security = config.security ?? 'starttls'
  const port = config.port ?? DEFAULT_SMTP_PORTS[security]
  const timeoutMs = config.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS
  const helo = config.helo ?? hostname()
  const credentials = config.username !== undefined || config.password !== undefined
  if (credentials && (config.username === undefined || config.password === undefined)) throw new Error('SMTP needs both a username and a password')
  if (credentials && security === 'none') throw new Error('SMTP credentials need TLS (security starttls or tls)')
  const tlsOptions: ConnectionOptions = { ...serverName(config.host), ...config.tls }
  return {
    send: async (message): Promise<SentEmail> => {
      const problem = validateEmail(message, config.from)
      if (problem) throw new EmailRejectedError(problem)
      const composed = composeMessage(message, config.from)
      const connection = new Connection(await open(config, security, port, timeoutMs), timeoutMs)
      try {
        await connection.expect([220], 'the connection')
        let features = extensions(await connection.command(`EHLO ${helo}`, [250]))
        if (security === 'starttls') {
          if (!features.has('STARTTLS')) throw new SmtpError(`SMTP server ${config.host} does not offer STARTTLS`)
          await connection.command('STARTTLS', [220])
          await connection.upgrade(tlsOptions)
          features = extensions(await connection.command(`EHLO ${helo}`, [250]))
        }
        if (credentials) await authenticate(connection, features, config.username!, config.password!)
        await connection.command(`MAIL FROM:<${composed.from}>`, [250])
        for (const recipient of composed.recipients) await connection.command(`RCPT TO:<${recipient}>`, [250, 251])
        await connection.command('DATA', [354])
        connection.write(`${dotStuff(composed.data)}.\r\n`)
        await connection.expect([250], 'the message')
        await connection.command('QUIT', [221]).catch(() => undefined)
        return { id: composed.id }
      } finally {
        connection.close()
      }
    },
  }
}
