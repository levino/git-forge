import { type EmailMessage, EmailRejectedError, type EmailSender, type SentEmail, validateEmail } from '@git-forge/core'

const RETRYABLE = new Set(['E_RATE_LIMIT_EXCEEDED', 'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', 'E_DELIVERY_FAILED'])

const address = (value: string): string | EmailAddress => {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(value)
  if (!match) return value.trim()
  return match[1] ? { name: match[1], email: match[2]! } : match[2]!
}

export const sendEmailBuilder = (message: EmailMessage, from: string): EmailMessageBuilder => ({
  from: address(message.from ?? from),
  to: [...message.to],
  ...(message.replyTo?.[0] ? { replyTo: message.replyTo[0] } : {}),
  subject: message.subject,
  text: message.text,
  ...(message.html !== undefined ? { html: message.html } : {}),
  ...(message.headers && Object.keys(message.headers).length > 0 ? { headers: { ...message.headers } } : {}),
})

export const createCloudflareEmailSender = (binding: SendEmail, from: string): EmailSender => ({
  send: async (message): Promise<SentEmail> => {
    const problem = validateEmail(message, from)
    if (problem) throw new EmailRejectedError(problem)
    try {
      return { id: (await binding.send(sendEmailBuilder(message, from))).messageId }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code !== 'string' || RETRYABLE.has(code)) throw error
      throw new EmailRejectedError(`Cloudflare Email Service rejected the message: ${code} ${(error as Error).message}`)
    }
  },
})
