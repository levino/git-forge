import { readAll, SizeLimitError } from '@git-forge/core'
import { base64UrlDecode, fromUtf8 } from './encoding.ts'

export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const

export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

const SUPPORTED = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS] as readonly string[]

const VERSION_META = 'io.modelcontextprotocol/protocolVersion'

export const JSONRPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const

export type ToolResult = {
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

export type McpTool<C> = {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly annotations?: Record<string, boolean>
  readonly call: (args: Record<string, unknown>, context: C) => Promise<ToolResult>
}

export type McpServer<C> = {
  readonly name: string
  readonly version: string
  readonly instructions: string
  readonly tools: readonly McpTool<C>[]
}

export const toolResult = (structuredContent: Record<string, unknown>, text: string): ToolResult => ({ content: [{ type: 'text', text }], structuredContent })

export const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

type Id = string | number | null

const respond = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })

const failure = (status: number, id: Id, code: number, message: string, data?: unknown): Response =>
  respond(status, { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const decodeHeader = (value: string | null): string | null => {
  const encoded = value === null ? null : /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(value)
  if (!encoded) return value
  try {
    return fromUtf8(base64UrlDecode(encoded[1]!.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')))
  } catch {
    return null
  }
}

const headerMismatch = (request: Request, version: string, method: string, params: Record<string, unknown>): string | null => {
  if (request.headers.get('MCP-Protocol-Version') !== version) return 'MCP-Protocol-Version header does not match the request body'
  if (request.headers.get('Mcp-Method') !== method) return 'Mcp-Method header does not match the request body'
  if (method === 'tools/call' && decodeHeader(request.headers.get('Mcp-Name')) !== params.name) return 'Mcp-Name header does not match the request body'
  return null
}

const toolDefinitions = <C>(server: McpServer<C>) =>
  server.tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema, ...(tool.annotations ? { annotations: tool.annotations } : {}) }))

export const handleMcpMessage = async <C>(server: McpServer<C>, request: Request, message: unknown, context: C): Promise<Response> => {
  if (!isObject(message) || message.jsonrpc !== '2.0') return failure(400, null, JSONRPC.invalidRequest, 'expected a single JSON-RPC 2.0 message')
  if (!('id' in message) || 'result' in message || 'error' in message) return new Response(null, { status: 202 })
  const id = message.id as Id
  if (typeof message.method !== 'string' || (typeof id !== 'string' && typeof id !== 'number')) return failure(400, null, JSONRPC.invalidRequest, 'invalid request')
  const method = message.method
  const params = isObject(message.params) ? message.params : {}
  const meta = isObject(params._meta) ? params._meta : {}
  const version = typeof meta[VERSION_META] === 'string' ? (meta[VERSION_META] as string) : null
  const modern = version !== null
  if (modern && !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return failure(400, id, JSONRPC.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED, requested: version })
  }
  if (modern) {
    const mismatch = headerMismatch(request, version, method, params)
    if (mismatch) return failure(400, id, JSONRPC.headerMismatch, `Header mismatch: ${mismatch}`)
  } else {
    const header = request.headers.get('MCP-Protocol-Version')
    if (header !== null && !(LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(header)) {
      return failure(400, id, JSONRPC.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED, requested: header })
    }
  }
  const complete = (result: Record<string, unknown>) => respond(200, { jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result } : result })
  const serverInfo = { name: server.name, version: server.version }
  if (!modern && method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null
    const protocolVersion = requested && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0]
    return complete({ protocolVersion, capabilities: { tools: {} }, serverInfo, instructions: server.instructions })
  }
  if (modern && method === 'server/discover') {
    return complete({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, instructions: server.instructions })
  }
  if (method === 'ping') return complete({})
  if (method === 'tools/list') return complete({ tools: toolDefinitions(server) })
  if (method === 'tools/call') {
    const tool = server.tools.find((candidate) => candidate.name === params.name)
    if (!tool) return failure(200, id, JSONRPC.invalidParams, `Unknown tool: ${String(params.name)}`)
    if (params.arguments !== undefined && !isObject(params.arguments)) return failure(200, id, JSONRPC.invalidParams, 'arguments must be an object')
    return complete({ ...(await tool.call((params.arguments as Record<string, unknown> | undefined) ?? {}, context)) })
  }
  return failure(modern ? 404 : 200, id, JSONRPC.methodNotFound, `Method not found: ${method}`)
}

export const handleMcpRequest = async <C>(server: McpServer<C>, request: Request, context: C, maxBytes = 64 * 1024): Promise<Response> => {
  let message: unknown
  try {
    message = JSON.parse(request.body ? fromUtf8(await readAll(request.body, maxBytes)) : '')
  } catch (error) {
    if (error instanceof SizeLimitError) return failure(413, null, JSONRPC.invalidRequest, 'request body too large')
    return failure(400, null, JSONRPC.parseError, 'Parse error')
  }
  return handleMcpMessage(server, request, message, context)
}
