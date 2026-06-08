#!/usr/bin/env node
/**
 * HTTP/SSE entry-point for hosted MCP at mcp.mnemohq.com.
 *
 * Each connecting client supplies its own GETMNEMO_API_KEY and
 * GETMNEMO_WORKSPACE_ID via OAuth (Phase 2) or via custom headers
 * `x-getmnemo-api-key` + `x-getmnemo-workspace-id` (Phase 1, dev-only).
 *
 * Listens on PORT (default 8787). Healthcheck at GET /healthz.
 */

import { createServer as createHttpServer } from 'node:http'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { createServer } from './server.js'

const PORT = Number(process.env.PORT ?? 8787)
const DEFAULT_API_URL = process.env.GETMNEMO_API_URL ?? 'https://api.mnemohq.com'

const httpServer = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', service: 'getmnemo-mcp' }))
    return
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('Not found. GET /mcp for the SSE stream, GET /healthz for liveness.\n')
    return
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'text/plain', allow: 'GET, POST' })
    res.end('Method not allowed.\n')
    return
  }

  const apiKey =
    (req.headers['x-getmnemo-api-key'] as string | undefined) ?? process.env.GETMNEMO_API_KEY
  const workspaceId =
    (req.headers['x-getmnemo-workspace-id'] as string | undefined) ??
    process.env.GETMNEMO_WORKSPACE_ID

  if (!apiKey || !workspaceId) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: 'Missing x-getmnemo-api-key and/or x-getmnemo-workspace-id headers.',
        hint: 'OAuth flow lands in v0.2; headers work today for trusted clients.',
      }),
    )
    return
  }

  const server = createServer({
    baseUrl: DEFAULT_API_URL,
    apiKey,
    workspaceId,
    actorId: req.headers['x-getmnemo-actor-id'] as string | undefined,
  })

  const transport = new SSEServerTransport('/mcp', res)

  // SSE keepalive: many proxies (CloudFront, ALB, nginx default 60s) close
  // idle connections, which silently breaks long-lived MCP sessions. Emit a
  // comment-frame heartbeat every 25s so the connection stays warm.
  const KEEPALIVE_MS = 25_000
  // Track tear-down so the heartbeat cannot race with cleanup. Without this
  // guard, `setInterval` can fire on the same tick that the client closes the
  // socket: clearInterval is queued, the timer callback is already running,
  // and `res.write` lands on a half-closed transport — Node throws
  // ERR_STREAM_WRITE_AFTER_END (uncaught here, the empty catch only swallows
  // synchronous errors; the actual error fires on the 'error' event).
  let closed = false
  const keepalive = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return
    try {
      // SSE comments start with ":" and are ignored by the client parser.
      res.write(`: keepalive ${Date.now()}\n\n`)
    } catch {
      // res may already be closed; cleanup will run via the 'close' handler.
    }
  }, KEEPALIVE_MS)
  // Don't keep the event loop alive solely for the heartbeat.
  keepalive.unref?.()

  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(keepalive)
    transport.close().catch(() => undefined)
    server.close().catch(() => undefined)
  }
  res.on('close', cleanup)
  res.on('error', cleanup)

  server.connect(transport).catch((err) => {
    process.stderr.write(`MCP transport error: ${err instanceof Error ? err.message : err}\n`)
    cleanup()
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'MCP transport failed to initialize' }))
    }
  })
})

httpServer.listen(PORT, () => {
  process.stdout.write(`Mnemo MCP HTTP listening on :${PORT}\n`)
})

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)))
process.on('SIGINT', () => httpServer.close(() => process.exit(0)))
