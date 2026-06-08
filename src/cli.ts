#!/usr/bin/env node
/**
 * Stdio entry-point for local MCP clients (Claude Desktop, Cursor, Windsurf, Zed).
 *
 * Reads config from env:
 *   GETMNEMO_API_URL      (default: https://api.mnemohq.com)
 *   GETMNEMO_API_KEY      (required)
 *   GETMNEMO_WORKSPACE_ID (required)
 *   GETMNEMO_ACTOR_ID     (optional)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

async function main(): Promise<void> {
  const apiKey = process.env.GETMNEMO_API_KEY
  const workspaceId = process.env.GETMNEMO_WORKSPACE_ID
  if (!apiKey || !workspaceId) {
    process.stderr.write(
      'Mnemo MCP: missing GETMNEMO_API_KEY and/or GETMNEMO_WORKSPACE_ID env vars.\n' +
        'Get a key at https://app.mnemohq.com/settings/api-keys\n',
    )
    process.exit(1)
  }

  const server = createServer({
    baseUrl: process.env.GETMNEMO_API_URL ?? 'https://api.mnemohq.com',
    apiKey,
    workspaceId,
    actorId: process.env.GETMNEMO_ACTOR_ID,
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Stays alive until parent process closes stdio.
}

main().catch((err) => {
  process.stderr.write(`Mnemo MCP fatal: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
