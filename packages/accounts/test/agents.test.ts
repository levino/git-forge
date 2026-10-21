import { describe, expect, it } from 'vitest'
import { clampAgentToken, clampTtlMinutes, parseAgentScope, parseClientRegistration, parseRedirectUri, redirectMatches, resolveResource } from '../src/agents.ts'

const ORIGIN = 'https://forge.example'

describe('clampAgentToken', () => {
  it('never exceeds the granted scope and lowers to the requested one', () => {
    expect(clampAgentToken({ scope: 'repo:write', repositoryIds: null }, { scope: 'repo:admin', repositoryIds: null })).toMatchObject({ scope: 'repo:write', repositoryIds: null })
    expect(clampAgentToken({ scope: 'repo:write', repositoryIds: null }, { scope: 'repo:read', repositoryIds: ['a'] })).toMatchObject({ scope: 'repo:read', repositoryIds: ['a'] })
  })

  it('keeps tokens inside the repository restriction of the connection', () => {
    const grant = { scope: 'repo:admin', repositoryIds: ['a', 'b'] } as const
    expect(clampAgentToken(grant, { scope: 'repo:read', repositoryIds: null })).toMatchObject({ repositoryIds: ['a', 'b'] })
    expect(clampAgentToken(grant, { scope: 'repo:read', repositoryIds: ['b'] })).toMatchObject({ repositoryIds: ['b'] })
    expect(clampAgentToken(grant, { scope: 'repo:read', repositoryIds: ['b', 'c'] })).toHaveProperty('error')
  })

  it('defaults the lifetime to an hour and caps it at a day', () => {
    expect(clampTtlMinutes(undefined)).toBe(60)
    expect(clampTtlMinutes('10')).toBe(60)
    expect(clampTtlMinutes(0)).toBe(1)
    expect(clampTtlMinutes(5.7)).toBe(5)
    expect(clampTtlMinutes(1e9)).toBe(1440)
    expect(clampAgentToken({ scope: 'repo:read', repositoryIds: null }, { scope: 'repo:read', repositoryIds: null, ttlMinutes: 1e9 })).toMatchObject({ ttlMs: 24 * 60 * 60 * 1000 })
  })
})

describe('redirect URIs', () => {
  it('accepts https, loopback http and private-use schemes only', () => {
    expect(parseRedirectUri('http://localhost:3000/callback')).toMatchObject({ loopback: true })
    expect(parseRedirectUri('https://claude.ai/api/mcp/auth_callback')).toMatchObject({ formAction: 'https://claude.ai', host: 'claude.ai' })
    expect(parseRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback')).toMatchObject({ formAction: 'cursor:' })
    for (const bad of ['http://example.com/cb', 'javascript:alert(1)', 'https://a.example/cb#x', 'https://u:p@a.example/cb', 'data:text/html,x', 'not a url']) expect(parseRedirectUri(bad)).toBeNull()
  })

  it('matches exactly, ignoring only the port of loopback redirects', () => {
    expect(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:51234/callback')).toBe(true)
    expect(redirectMatches(['http://localhost:3000/callback'], 'http://localhost:3000/other')).toBe(false)
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb/')).toBe(false)
    expect(redirectMatches(['https://a.example/cb'], 'https://a.example/cb')).toBe(true)
  })
})

describe('resolveResource', () => {
  it('binds tokens to this forge’s MCP endpoint only', () => {
    expect(resolveResource(ORIGIN, null)).toBe(`${ORIGIN}/mcp`)
    expect(resolveResource(ORIGIN, `${ORIGIN}/mcp`)).toBe(`${ORIGIN}/mcp`)
    expect(resolveResource(ORIGIN, `${ORIGIN}/mcp/`)).toBe(`${ORIGIN}/mcp`)
    expect(resolveResource(ORIGIN, 'HTTPS://FORGE.EXAMPLE')).toBe(`${ORIGIN}/mcp`)
    expect(resolveResource(ORIGIN, 'https://evil.example/mcp')).toBeNull()
    expect(resolveResource(ORIGIN, `${ORIGIN}/api`)).toBeNull()
    expect(resolveResource(ORIGIN, `${ORIGIN}/mcp#x`)).toBeNull()
  })
})

describe('parseAgentScope', () => {
  it('takes the highest repository scope, ignores offline_access and refuses unknown scopes', () => {
    expect(parseAgentScope(null)).toBe('repo:write')
    expect(parseAgentScope('offline_access')).toBe('repo:write')
    expect(parseAgentScope('repo:read offline_access')).toBe('repo:read')
    expect(parseAgentScope('repo:read repo:admin')).toBe('repo:admin')
    expect(parseAgentScope('repo:read email')).toBeNull()
  })
})

describe('parseClientRegistration', () => {
  it('registers public clients with cleaned metadata', () => {
    expect(parseClientRegistration({ client_name: 'Claude\u0000 Code', redirect_uris: ['http://localhost:1/cb', 'http://localhost:1/cb'], client_uri: 'javascript:x' })).toEqual({
      name: 'Claude Code',
      uri: null,
      redirectUris: ['http://localhost:1/cb'],
      softwareId: null,
      softwareVersion: null,
    })
    expect(parseClientRegistration({ redirect_uris: [] })).toHaveProperty('error', 'invalid_redirect_uri')
    expect(parseClientRegistration({ redirect_uris: ['http://example.com/cb'] })).toHaveProperty('error', 'invalid_redirect_uri')
    expect(parseClientRegistration({ redirect_uris: ['https://a.example/cb'], grant_types: ['client_credentials'] })).toHaveProperty('error', 'invalid_client_metadata')
  })
})
