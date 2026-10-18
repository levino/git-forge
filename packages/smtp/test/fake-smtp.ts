import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createNetServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSecureContext, createServer as createTlsServer, type SecureContext, TLSSocket } from 'node:tls'

export type Certificate = { readonly cert: string; readonly key: string }

export const selfSignedCertificate = (): Certificate => {
  const dir = mkdtempSync(join(tmpdir(), 'git-forge-smtp-'))
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
      { stdio: 'ignore' },
    )
    return { cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), key: readFileSync(join(dir, 'key.pem'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export type ReceivedMessage = {
  readonly from: string
  readonly recipients: readonly string[]
  readonly data: string
  readonly auth: { readonly mechanism: string; readonly username: string; readonly password: string } | null
  readonly secure: boolean
}

export type FakeSmtpOptions = {
  readonly mode: 'starttls' | 'tls' | 'none'
  readonly certificate?: Certificate
  readonly mechanisms?: readonly string[]
  readonly users?: Readonly<Record<string, string>>
  readonly rcpt?: (address: string) => string | null
  readonly offerStarttls?: boolean
}

export type FakeSmtpServer = {
  readonly port: number
  readonly messages: ReceivedMessage[]
  readonly transcripts: string[][]
  close(): Promise<void>
}

const decode = (text: string) => Buffer.from(text, 'base64').toString('utf8')

export const startFakeSmtp = async (options: FakeSmtpOptions): Promise<FakeSmtpServer> => {
  const messages: ReceivedMessage[] = []
  const transcripts: string[][] = []
  const context: SecureContext | undefined = options.certificate ? createSecureContext(options.certificate) : undefined
  const sockets = new Set<Socket>()

  const session = (initial: Socket, startedSecure: boolean) => {
    sockets.add(initial)
    const transcript: string[] = []
    transcripts.push(transcript)
    let socket: Socket = initial
    let secure = startedSecure
    let buffer = ''
    let from = ''
    let recipients: string[] = []
    let auth: ReceivedMessage['auth'] = null
    let data: string[] | null = null
    let login: { step: 'username' | 'password'; username?: string } | null = null
    const send = (line: string) => {
      transcript.push(`S: ${line}`)
      socket.write(`${line}\r\n`)
    }
    const ehlo = () => {
      const lines = ['localhost']
      if (options.mode === 'starttls' && !secure && options.offerStarttls !== false) lines.push('STARTTLS')
      if (options.mechanisms && (secure || options.mode === 'none')) lines.push(`AUTH ${options.mechanisms.join(' ')}`)
      lines.push('8BITMIME')
      lines.forEach((line, index) => send(`250${index === lines.length - 1 ? ' ' : '-'}${line}`))
    }
    const checkUser = (mechanism: string, username: string, password: string) => {
      if (options.users?.[username] === password) {
        auth = { mechanism, username, password }
        send('235 2.7.0 authenticated')
      } else send('535 5.7.8 bad credentials')
    }
    const line = (text: string) => {
      if (data) {
        if (text === '.') {
          messages.push({ from, recipients, data: data.join('\r\n'), auth, secure })
          data = null
          send('250 2.0.0 queued')
        } else data.push(text.startsWith('..') ? text.slice(1) : text)
        return
      }
      transcript.push(`C: ${text}`)
      if (login) {
        if (login.step === 'username') {
          login = { step: 'password', username: decode(text) }
          send(`334 ${Buffer.from('Password:').toString('base64')}`)
        } else {
          const username = login.username!
          login = null
          checkUser('LOGIN', username, decode(text))
        }
        return
      }
      const [verb = '', ...rest] = text.split(' ')
      switch (verb.toUpperCase()) {
        case 'EHLO':
          ehlo()
          return
        case 'STARTTLS': {
          send('220 2.0.0 ready')
          socket.removeListener('data', onData)
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context! })
          upgraded.on('error', () => undefined)
          upgraded.on('secure', () => {
            secure = true
          })
          socket = upgraded
          socket.on('data', onData)
          return
        }
        case 'AUTH': {
          const [mechanism = '', initial] = rest
          if (mechanism === 'PLAIN' && initial) {
            const [, username = '', password = ''] = decode(initial).split('\0')
            checkUser('PLAIN', username, password)
          } else if (mechanism === 'LOGIN') {
            login = { step: 'username' }
            send(`334 ${Buffer.from('Username:').toString('base64')}`)
          } else send('504 5.5.4 unsupported')
          return
        }
        case 'MAIL':
          from = /<(.*)>/.exec(text)![1]!
          recipients = []
          send('250 2.1.0 ok')
          return
        case 'RCPT': {
          const address = /<(.*)>/.exec(text)![1]!
          const refusal = options.rcpt?.(address) ?? null
          if (refusal) send(refusal)
          else {
            recipients.push(address)
            send('250 2.1.5 ok')
          }
          return
        }
        case 'DATA':
          data = []
          send('354 go ahead')
          return
        case 'QUIT':
          send('221 2.0.0 bye')
          socket.end()
          return
        default:
          send('502 5.5.2 unknown command')
      }
    }
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        line(text)
      }
    }
    socket.on('data', onData)
    socket.on('error', () => undefined)
    socket.on('close', () => sockets.delete(initial))
    send('220 localhost ESMTP fake')
  }

  const server: Server =
    options.mode === 'tls'
      ? createTlsServer({ ...options.certificate! }, (socket) => session(socket, true))
      : createNetServer((socket) => session(socket, false))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    messages,
    transcripts,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
