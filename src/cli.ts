#!/usr/bin/env node
/**
 * Stdio entry-point for local MCP clients (Claude Desktop, Cursor, Windsurf, Zed).
 *
 * Reads config from env:
 *   LEDGERMEM_API_URL      (default: https://api.proofly.dev)
 *   LEDGERMEM_API_KEY      (required)
 *   LEDGERMEM_WORKSPACE_ID (required)
 *   LEDGERMEM_ACTOR_ID     (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const apiKey = process.env.LEDGERMEM_API_KEY
  const workspaceId = process.env.LEDGERMEM_WORKSPACE_ID
  if (!apiKey || !workspaceId) {
    process.stderr.write(
      'LedgerMem MCP: missing LEDGERMEM_API_KEY and/or LEDGERMEM_WORKSPACE_ID env vars.\n' +
        'Get a key at https://app.proofly.dev/settings/api-keys\n',
    )
    process.exit(1)
  }

  const server = createServer({
    baseUrl: process.env.LEDGERMEM_API_URL ?? 'https://api.proofly.dev',
    apiKey,
    workspaceId,
    actorId: process.env.LEDGERMEM_ACTOR_ID,
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Stays alive until parent process closes stdio.
}

main().catch((err) => {
  process.stderr.write(`LedgerMem MCP fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
