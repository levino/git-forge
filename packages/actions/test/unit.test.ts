import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { conclusionOf, expressionToken, generateRunnerKey, parseTaskResult, signWebhookPayload, stepCondition, verifyClientAssertion } from '../src/index.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('package rules', () => {
  it('uses only web-standard APIs in src', () => {
    for (const file of readdirSync(`${root}src/`)) expect(readFileSync(`${root}src/${file}`, 'utf8')).not.toMatch(/from ['"]node:|require\(/)
  })
})

describe('expressions', () => {
  it('keeps literals and turns ${{ }} into format() expressions', () => {
    expect(expressionToken('plain')).toBe('plain')
    expect(expressionToken('${{ github.sha }}')).toEqual({ type: 3, expr: 'github.sha' })
    expect(expressionToken("it's {x} ${{ a }}-${{ b }}!")).toEqual({ type: 3, expr: "format('it''s {{x}} {0}-{1}!', a, b)" })
  })

  it('adds success() unless a status function is used', () => {
    expect(stepCondition(undefined)).toBe('success()')
    expect(stepCondition("github.ref == 'refs/heads/main'")).toBe("success() && (github.ref == 'refs/heads/main')")
    expect(stepCondition('always()')).toBe('always()')
  })

  it('maps task results', () => {
    expect(parseTaskResult(0)).toBe('succeeded')
    expect(parseTaskResult('Failed')).toBe('failed')
    expect(parseTaskResult('bogus')).toBeNull()
    expect(conclusionOf('canceled')).toBe('cancelled')
    expect(conclusionOf('succeededWithIssues')).toBe('success')
  })
})

describe('webhooks', () => {
  it('signs payloads like GitHub (X-Hub-Signature-256)', async () => {
    expect(await signWebhookPayload("It's a Secret to Everybody", 'Hello, World!')).toBe('sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17')
  })
})

describe('client assertions', () => {
  it('rejects malformed, expired and wrongly addressed assertions', async () => {
    const { publicKey } = await generateRunnerKey()
    const check = { clientId: 'c', audience: 'https://forge/_services/actions/_apis/v1/auth/', now: Date.now() }
    expect(await verifyClientAssertion('not-a-jwt', publicKey, check)).toBe(false)
    const unsigned = (claims: object) => `${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify(claims)).replace(/=+$/, '')}.AAAA`
    expect(await verifyClientAssertion(unsigned({ iss: 'c', sub: 'c', aud: check.audience, exp: 1 }), publicKey, check)).toBe(false)
    expect(await verifyClientAssertion(unsigned({ iss: 'c', sub: 'c', aud: 'elsewhere', exp: Date.now() / 1000 + 60 }), publicKey, check)).toBe(false)
  })
})
