import type { EmailMessage } from '@git-forge/core'

const encoder = new TextEncoder()

const ASCII = /^[\x20-\x7e]*$/

const ATOM_PHRASE = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]*$/

const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

const wrap = (text: string, width = 76): string => {
  const lines: string[] = []
  for (let index = 0; index < text.length; index += width) lines.push(text.slice(index, index + width))
  return lines.join('\r\n')
}

export const encodeWords = (value: string): string => {
  if (ASCII.test(value)) return value
  const words: string[] = []
  let chunk = ''
  for (const char of value) {
    if (encoder.encode(chunk + char).length > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join('\r\n ')
}

export const parseMailbox = (value: string): { readonly name: string | null; readonly address: string } => {
  const match = /^\s*(.*?)\s*<([^<>]+)>\s*$/.exec(value)
  if (!match) return { name: null, address: value.trim() }
  const name = match[1]!.replace(/^"(.*)"$/, '$1').trim()
  return { name: name === '' ? null : name, address: match[2]!.trim() }
}

export const formatMailbox = (value: string): string => {
  const { name, address } = parseMailbox(value)
  if (name === null) return address
  if (ATOM_PHRASE.test(name)) return `${name} <${address}>`
  if (ASCII.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`
  return `${encodeWords(name)} <${address}>`
}

const canonical = (text: string): string => text.replace(/\r?\n/g, '\r\n')

const part = (type: string, text: string): string =>
  [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', wrap(base64(encoder.encode(canonical(text))))].join('\r\n')

export const formatDate = (date: Date): string => date.toUTCString().replace(/GMT$/, '+0000')

export type ComposedMessage = {
  readonly id: string
  readonly from: string
  readonly recipients: readonly string[]
  readonly data: string
}

export const composeMessage = (message: EmailMessage, defaultFrom: string, options: { readonly date?: Date; readonly id?: string } = {}): ComposedMessage => {
  const from = message.from ?? defaultFrom
  const sender = parseMailbox(from).address
  const domain = sender.slice(sender.lastIndexOf('@') + 1)
  const id = options.id ?? `<${crypto.randomUUID()}@${domain}>`
  const headers = [
    `From: ${formatMailbox(from)}`,
    `To: ${message.to.join(', ')}`,
    ...(message.replyTo && message.replyTo.length > 0 ? [`Reply-To: ${message.replyTo.join(', ')}`] : []),
    `Subject: ${encodeWords(message.subject)}`,
    `Date: ${formatDate(options.date ?? new Date())}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    ...Object.entries(message.headers ?? {}).map(([name, value]) => `${name}: ${encodeWords(value)}`),
  ]
  let data: string
  if (message.html === undefined) {
    data = `${headers.join('\r\n')}\r\n${part('text/plain', message.text)}\r\n`
  } else {
    const boundary = `=_${crypto.randomUUID()}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    const body = [`--${boundary}`, part('text/plain', message.text), `--${boundary}`, part('text/html', message.html), `--${boundary}--`, ''].join('\r\n')
    data = `${headers.join('\r\n')}\r\n\r\n${body}`
  }
  return { id, from: sender, recipients: [...message.to], data }
}

export const dotStuff = (data: string): string => data.replace(/(^|\r\n)\./g, '$1..')
