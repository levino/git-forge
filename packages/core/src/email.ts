export type EmailMessage = {
  readonly from?: string
  readonly to: readonly string[]
  readonly replyTo?: readonly string[]
  readonly subject: string
  readonly text: string
  readonly html?: string
  readonly headers?: Readonly<Record<string, string>>
}

export type SentEmail = {
  readonly id: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<SentEmail>
}

export class EmailRejectedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmailRejectedError'
  }
}

const ADDRESS = /^[^\s@<>()",;:\\[\]]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

export const isEmailAddress = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && ADDRESS.test(value)

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/

export const validateEmail = (message: EmailMessage, defaultFrom?: string): string | null => {
  const from = message.from ?? defaultFrom
  if (from === undefined) return 'from address is missing'
  if (!isEmailAddress(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) return `invalid from address ${from}`
  if (message.to.length === 0) return 'no recipients'
  for (const address of [...message.to, ...(message.replyTo ?? [])]) {
    if (!isEmailAddress(address)) return `invalid address ${address}`
  }
  if (/[\r\n]/.test(message.subject)) return 'subject must be a single line'
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    if (!HEADER_NAME.test(name) || /[\r\n]/.test(value)) return `invalid header ${name}`
  }
  return null
}

export type MemoryEmailSender = EmailSender & {
  readonly sent: readonly (EmailMessage & { readonly id: string })[]
}

export const createMemoryEmailSender = (defaultFrom = 'forge@example.test'): MemoryEmailSender => {
  const sent: (EmailMessage & { readonly id: string })[] = []
  return {
    sent,
    send: async (message) => {
      const problem = validateEmail(message, defaultFrom)
      if (problem) throw new EmailRejectedError(problem)
      const id = `memory-${sent.length + 1}`
      sent.push({ ...message, from: message.from ?? defaultFrom, id })
      return { id }
    },
  }
}

export const createConsoleEmailSender = (defaultFrom: string, log: (line: string) => void = console.log): EmailSender => ({
  send: async (message) => {
    const problem = validateEmail(message, defaultFrom)
    if (problem) throw new EmailRejectedError(problem)
    const id = `console-${crypto.randomUUID()}`
    log(JSON.stringify({ event: 'email', id, from: message.from ?? defaultFrom, to: message.to, subject: message.subject, text: message.text }))
    return { id }
  },
})
