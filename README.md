# getmnemo-mcp

Model Context Protocol server for [Mnemo Memory](https://mnemohq.com) — exposes long-term memory tools to any MCP client (Claude Desktop, Cursor, Windsurf, VS Code, Zed).

## Tools

| Tool | What it does |
|---|---|
| `memory_search` | Hybrid 7-strategy retrieval over the workspace memory store. |
| `memory_add` | Store an atomic fact with optional metadata. |
| `memory_get` | Fetch one memory by ID within the configured container. |
| `memory_update` | Patch an existing memory's content or metadata. |
| `memory_delete` | Soft-delete a memory by ID so it leaves retrieval. |
| `memory_list` | Paginate through memories (cursor-based). |

Remote HTTP calls are scoped by the user's Mnemo OAuth grant. The user signs
in, chooses a workspace and memory container, and the server derives that
scope from the access token. The model cannot set or change it.

## Install

### Local stdio clients

```bash
npx -y getmnemo-mcp
```

Or wire it into the client config directly. Example for Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "getmnemo": {
      "command": "npx",
      "args": ["-y", "getmnemo-mcp"],
      "env": {
        "GETMNEMO_API_KEY": "prfly_live_...",
        "GETMNEMO_WORKSPACE_ID": "ws_...",
        "GETMNEMO_CONTAINER_TAG": "user:jane"
      }
    }
  }
}
```

Get an API key at <https://app.mnemohq.com/settings/api-keys>.

### Hosted remote MCP clients

For clients that support remote MCP and OAuth 2.1, use:

```text
https://mcp.mnemohq.com/mcp
```

The client should discover OAuth metadata, open Mnemo sign-in, and return to
the client after the user selects a workspace and container. No API key,
workspace header, or container configuration is required for this path.

## Develop

```bash
npm install
cp .env.example .env   # fill in API-key/container values for stdio
npm run dev            # stdio
npm run dev:http       # Streamable HTTP on :8787
npm run build          # bundle to dist/
```

## Architecture

- **stdio** (`src/cli.ts`): one process per MCP client connection, env-configured.
- **Streamable HTTP** (`src/http.ts`): hosted transport for public OAuth sessions, with private API-key compatibility for trusted deployments.
- Both transports share `src/server.ts` (tool registration + dispatch) and `src/api-client.ts` (typed REST wrapper).

The public hosted transport uses Mnemo's OAuth 2.1 authorization server and
resource-bound tokens. Header-selected containers remain disabled by default;
they are only a private compatibility path for a trusted gateway.

The server deliberately does NOT depend on `getmnemo` (the JS SDK) so it can ship independently.

## License

MIT
