import { describe, expect, it } from 'vitest'
import { createConsoleEmailSender, createMemoryEmailSender, EmailRejectedError, isEmailAddress, validateEmail } from '../src/email.ts'
import { parseCommitMetadata } from '../src/objects.ts'
import { utf8 } from '../src/bytes.ts'

describe('email adapters', () => {
  it('validates addresses, subjects and headers', () => {
    expect(isEmailAddress('ada@example.org')).toBe(true)
    expect(isEmailAddress('ada@localhost')).toBe(false)
    expect(isEmailAddress('a b@example.org')).toBe(false)
    expect(validateEmail({ to: ['ada@example.org'], subject: 'hi', text: 'x' }, 'Forge <forge@example.org>')).toBeNull()
    expect(validateEmail({ to: ['ada@example.org'], subject: 'hi', text: 'x' })).toBe('from address is missing')
    expect(validateEmail({ from: 'forge@example.org', to: [], subject: 'hi', text: 'x' })).toBe('no recipients')
    expect(validateEmail({ from: 'forge@example.org', to: ['ada@example.org'], subject: 'a\r\nBcc: x', text: 'x' })).toBe('subject must be a single line')
    expect(validateEmail({ from: 'forge@example.org', to: ['ada@example.org'], subject: 's', text: 'x', headers: { 'X-A': 'b\nc' } })).toBe('invalid header X-A')
  })

  it('records messages in memory and rejects invalid ones', async () => {
    const sender = createMemoryEmailSender('forge@example.org')
    expect(await sender.send({ to: ['ada@example.org'], subject: 'Hello', text: 'Body' })).toEqual({ id: 'memory-1' })
    expect(sender.sent[0]).toMatchObject({ from: 'forge@example.org', to: ['ada@example.org'], subject: 'Hello' })
    await expect(sender.send({ to: ['nobody'], subject: 'x', text: 'x' })).rejects.toBeInstanceOf(EmailRejectedError)
  })

  it('logs messages as JSON lines', async () => {
    const lines: string[] = []
    const sender = createConsoleEmailSender('forge@example.org', (line) => lines.push(line))
    const { id } = await sender.send({ to: ['ada@example.org'], subject: 'Digest', text: 'two notifications' })
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'email', id, to: ['ada@example.org'], subject: 'Digest' })
  })
})

describe('parseCommitMetadata', () => {
  it('reads author, committer and message', () => {
    const tree = 'a'.repeat(40)
    const data = utf8(`tree ${tree}\nparent ${'b'.repeat(40)}\nauthor Ada Lovelace <ada@example.org> 1700000000 +0100\ncommitter C <c@example.org> 1700000100 -0200\n\nFix the engine\n\nDetails\n`)
    const commit = parseCommitMetadata(data)
    expect(commit.tree).toBe(tree)
    expect(commit.author).toEqual({ name: 'Ada Lovelace', email: 'ada@example.org', timestamp: 1700000000, timezone: '+0100' })
    expect(commit.committer?.timezone).toBe('-0200')
    expect(commit.message).toBe('Fix the engine\n\nDetails\n')
  })
})
