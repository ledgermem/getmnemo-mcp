# @ledgermem/mcp-server

Model Context Protocol server for [LedgerMem Memory](https://proofly.dev) — exposes long-term memory tools to any MCP client (Claude Desktop, Cursor, Windsurf, VS Code, Zed).

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid 7-strategy retrieval over the workspace memory store. |
| `memory_add` | Store an atomic fact with optional metadata. |
| `memory_update` | Patch an existing memory's content or metadata. |
| `memory_delete` | Permanently remove a memory by ID. |
| `memory_list` | Paginate through memories (cursor-based). |

All calls are scoped to a workspace and (optionally) an actor.

## Install

### Claude Desktop / Cursor / Windsurf / VS Code / Zed

```bash
npx -y @ledgermem/mcp-server
```

Or wire it into the client config directly. Example for Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ledgermem": {
      "command": "npx",
      "args": ["-y", "@ledgermem/mcp-server"],
      "env": {
        "LEDGERMEM_API_KEY": "lk_live_...",
        "LEDGERMEM_WORKSPACE_ID": "ws_..."
      }
    }
  }
}
```

Get an API key at <https://app.proofly.dev/settings/api-keys>.

### Hosted (HTTP/SSE) at `mcp.proofly.dev`

```bash
npx -y install-mcp@latest https://mcp.proofly.dev/mcp --client claude
```

(OAuth flow lands in v0.2 — until then the hosted endpoint accepts `x-ledgermem-api-key` + `x-ledgermem-workspace-id` headers from trusted clients.)

## Develop

```bash
npm install
cp .env.example .env   # fill in LEDGERMEM_API_KEY + LEDGERMEM_WORKSPACE_ID
npm run dev            # stdio
npm run dev:http       # HTTP/SSE on :8787
npm run build          # bundle to dist/
```

## Architecture

- **stdio** (`src/cli.ts`): one process per MCP client connection, env-configured.
- **HTTP/SSE** (`src/http.ts`): single long-running process for hosted use, header-or-OAuth auth.
- Both transports share `src/server.ts` (tool registration + dispatch) and `src/api-client.ts` (typed REST wrapper).

The server deliberately does NOT depend on `@ledgermem/memory` (the JS SDK) so it can ship independently.

## License

MIT
