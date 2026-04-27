#!/usr/bin/env node
/**
 * HTTP/SSE entry-point for hosted MCP at mcp.proofly.dev.
 *
 * Each connecting client supplies its own LEDGERMEM_API_KEY and
 * LEDGERMEM_WORKSPACE_ID via OAuth (Phase 2) or via custom headers
 * `x-ledgermem-api-key` + `x-ledgermem-workspace-id` (Phase 1, dev-only).
 *
 * Listens on PORT (default 8787). Healthcheck at GET /healthz.
 */

import { createServer as createHttpServer } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer } from './server.js'

const PORT = Number(process.env.PORT ?? 8787)
const DEFAULT_API_URL = process.env.LEDGERMEM_API_URL ?? 'https://api.proofly.dev'

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'ledgermem-mcp' }))
    return
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found. POST /mcp for the MCP endpoint, GET /healthz for liveness.\n')
    return
  }

  const apiKey =
    (req.headers['x-ledgermem-api-key'] as string | undefined) ?? process.env.LEDGERMEM_API_KEY
  const workspaceId =
    (req.headers['x-ledgermem-workspace-id'] as string | undefined) ??
    process.env.LEDGERMEM_WORKSPACE_ID

  if (!apiKey || !workspaceId) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: 'Missing x-ledgermem-api-key and/or x-ledgermem-workspace-id headers.',
        hint: 'OAuth flow lands in v0.2; headers work today for trusted clients.',
      }),
    )
    return
  }

  const server = createServer({
    baseUrl: DEFAULT_API_URL,
    apiKey,
    workspaceId,
    actorId: req.headers['x-ledgermem-actor-id'] as string | undefined,
  })

  const transport = new SSEServerTransport('/mcp', res)
  server.connect(transport).catch((err) => {
    process.stderr.write(`MCP transport error: ${err instanceof Error ? err.message : err}\n`)
  })
})

httpServer.listen(PORT, () => {
  process.stdout.write(`LedgerMem MCP HTTP listening on :${PORT}\n`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
