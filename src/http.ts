/**
 * Streamable HTTP entry point for hosted MCP clients.
 *
 * Supports public OAuth access tokens and private API-key sessions. Public
 * OAuth sessions derive workspace/container scope from Mnemo's grant; the
 * MCP client cannot provide or change that scope.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createServer } from './server.js'
import { resolveContainerFromEnv, resolveContainerFromHeaders } from './config.js'
import type { ContainerScope } from './api-client.js'

type EnvLike = Record<string, string | undefined>
const DEFAULT_API_URL = process.env.GETMNEMO_API_URL ?? 'https://api.mnemohq.com'

function bearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7).trim() || undefined
  const legacy = req.headers['x-getmnemo-api-key']
  return typeof legacy === 'string' ? legacy.trim() || undefined : undefined
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ error: message }))
}

function resolveRequestContainer(req: IncomingMessage, env: EnvLike): ContainerScope | null {
  if (env.GETMNEMO_ALLOW_HEADER_SCOPE !== '1') return resolveContainerFromEnv(env)
  return resolveContainerFromHeaders(
    headerValue(req, 'x-getmnemo-container-tag'),
    headerValue(req, 'x-getmnemo-scope-type'),
    headerValue(req, 'x-getmnemo-scope-id'),
    env,
  )
}

export function createMcpHttpServer(env: EnvLike = process.env) {
  const apiUrl = env.GETMNEMO_API_URL ?? DEFAULT_API_URL

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ status: 'ok', service: 'getmnemo-mcp', transport: 'streamable-http' }))
      return
    }
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' })
      res.end(JSON.stringify({
        resource: 'https://mcp.mnemohq.com/mcp',
        authorization_servers: ['https://api.mnemohq.com/v1/mcp/oauth'],
        scopes_supported: ['memories:read', 'memories:write', 'memories:delete', 'search:read'],
        bearer_methods_supported: ['header'],
      }))
      return
    }
    if (url.pathname !== '/mcp') {
      reject(res, 404, 'Not found. Use POST or GET /mcp.')
      return
    }
    if (!['GET', 'POST'].includes(req.method ?? '')) {
      res.writeHead(405, { allow: 'GET, POST' })
      res.end()
      return
    }

    const credential = bearerToken(req)
    if (!credential) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="mcp", resource_metadata="https://mcp.mnemohq.com/.well-known/oauth-protected-resource"')
      reject(res, 401, 'OAuth authorization is required. Connect this MCP server from a client that supports remote OAuth.')
      return
    }

    let workspaceId: string | undefined
    let container: ContainerScope | null = null
    if (credential.split('.').length === 3) {
      const introspection = await fetch(`${apiUrl}/v1/mcp/oauth/introspect`, {
        headers: { authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(5_000),
      })
      if (!introspection.ok) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="mcp", error="invalid_token", resource_metadata="https://mcp.mnemohq.com/.well-known/oauth-protected-resource"')
        reject(res, 401, 'The MCP authorization token is invalid or expired.')
        return
      }
      const identity: unknown = await introspection.json()
      if (!identity || typeof identity !== 'object') {
        reject(res, 401, 'Invalid MCP authorization response.')
        return
      }
      const record = identity as Record<string, unknown>
      workspaceId = typeof record.tenantId === 'string' ? record.tenantId : undefined
      const tag = typeof record.containerTag === 'string' ? record.containerTag : undefined
      if (workspaceId && tag) container = { containerTag: tag }
    } else {
      workspaceId = headerValue(req, 'x-getmnemo-workspace-id') ?? env.GETMNEMO_WORKSPACE_ID
      container = resolveRequestContainer(req, env)
    }
    if (!workspaceId || !container) {
      reject(res, 400, 'The MCP authorization grant has no valid workspace/container scope.')
      return
    }

    // Stateless mode is intentional for the public service: no in-memory
    // session map means Azure replicas can serve subsequent MCP requests
    // without sticky routing or shared session storage.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    const server = createServer({
      baseUrl: apiUrl,
      apiKey: credential,
      workspaceId,
      container,
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
    await server.close()
  })

  return httpServer
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8787)
  const server = createMcpHttpServer()
  server.listen(port, () => process.stdout.write(`Mnemo MCP HTTP listening on :${port}\n`))
  const shutdown = (): void => {
    server.close(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
