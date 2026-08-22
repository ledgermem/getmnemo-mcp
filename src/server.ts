/**
 * MCP server factory.
 *
 * Exposes memory tools to MCP clients (Claude Desktop, Cursor, Windsurf, VS
 * Code, Zed): search, add, get, update, delete, and list.
 *
 * Transport-agnostic — wire to stdio (cli.ts) or HTTP/SSE (http.ts).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { MnemoApiClient, type ApiClientConfig, MnemoApiError } from './api-client.js'

// SECURITY: tool inputs expose content/query knobs plus an OPTIONAL `container`
// tag for the hosted multi-container model. The container is NOT a free tenant
// boundary — the API validates it against the connection's allowed set (403 if
// out of scope). When omitted, the server-configured default/allowed containers
// apply. The model can only target containers the connection already permits.
const CONTAINER_DESCRIPTION =
  "Target memory container tag. Omit to use the connection's default/allowed containers."
const containerField = z
  .string()
  .min(1)
  .max(200)
  .optional()
  .describe(CONTAINER_DESCRIPTION)

const SearchInput = z.object({
  query: z.string().min(1).max(2000).describe('Natural-language search query.'),
  limit: z.number().int().min(1).max(50).default(8).describe('Max number of memories to return.'),
  container: containerField,
})

// Cap metadata size so a malicious or buggy client cannot push a 10MB blob
// through the MCP boundary (the upstream API enforces its own limits, but
// we'd rather reject early than waste a round-trip).
const METADATA_MAX_SERIALIZED_BYTES = 16 * 1024
const boundedMetadata = z
  .record(z.unknown())
  .refine(
    (m) => {
      try {
        return Buffer.byteLength(JSON.stringify(m), 'utf8') <= METADATA_MAX_SERIALIZED_BYTES
      } catch {
        return false
      }
    },
    { message: `metadata exceeds ${METADATA_MAX_SERIALIZED_BYTES} bytes when serialized` },
  )

const AddInput = z.object({
  content: z.string().min(1).max(10_000).describe('The fact or memory to store.'),
  memoryType: z.string().min(1).max(100).optional(),
  metadata: boundedMetadata
    .optional()
    .describe('Arbitrary JSON metadata (tags, source, etc.). Max 16KB serialized.'),
  source: boundedMetadata.optional().describe('Provenance for this memory.'),
  idempotencyKey: z.string().min(1).max(200).optional(),
  container: containerField,
})

const UpdateInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID returned by memory_add or memory_search.'),
  content: z.string().min(1).max(10_000).optional(),
  memoryType: z.string().min(1).max(100).optional(),
  metadata: boundedMetadata.optional(),
  source: boundedMetadata.nullable().optional(),
  container: containerField,
})

const GetInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID returned by memory_add or memory_search.'),
  container: containerField,
})

const DeleteInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID to delete.'),
  container: containerField,
})

const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1024).optional(),
  container: containerField,
})

const TOOLS: Tool[] = [
  {
    name: 'memory_search',
    description:
      'Search the Mnemo memory store for facts relevant to a query. Returns ranked results (the `results` array) with content, score, and source citations. Use this BEFORE answering any question that might require remembered context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_add',
    description:
      'Store a new atomic fact in long-term memory. Use this whenever the user reveals durable preferences, facts about themselves, or context that should persist across sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        metadata: { type: 'object' },
        memoryType: { type: 'string' },
        source: { type: 'object' },
        idempotencyKey: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_update',
    description:
      "Update an existing memory's content or metadata. Use when a previously-stored fact is no longer accurate.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        content: { type: 'string' },
        metadata: { type: 'object' },
        memoryType: { type: 'string' },
        source: { type: 'object', nullable: true },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_get',
    description: 'Fetch one memory by ID within the configured tenant container.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_delete',
    description:
      'Delete a memory by ID. Use only when the user explicitly asks to forget something or when a fact is permanently invalid.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_list',
    description:
      'List memories in the workspace with cursor pagination. Useful for review/debug; prefer memory_search for retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        cursor: { type: 'string' },
        container: { type: 'string', description: CONTAINER_DESCRIPTION },
      },
    },
  },
]

export function createServer(cfg: ApiClientConfig): Server {
  const api = new MnemoApiClient(cfg)
  const server = new Server(
    { name: 'getmnemo', version: '0.2.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const result = await dispatch(api, name, args ?? {})
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } catch (err) {
      if (err instanceof McpError) throw err
      const message =
        err instanceof MnemoApiError
          ? formatApiError(err, requestedContainer(args))
          : err instanceof z.ZodError
            ? `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
            : err instanceof Error
              ? err.message
              : 'Unknown error'
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      }
    }
  })

  return server
}

/** Extract the per-call `container` tag from raw tool args, if any. */
function requestedContainer(args: unknown): string | undefined {
  if (args && typeof args === 'object' && 'container' in args) {
    const value = (args as { container: unknown }).container
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Turn a Mnemo API error into a clear MCP tool message. Container-scope
 * failures (403 out-of-scope, 400 write-needs-container) get actionable text
 * instead of a raw status dump.
 */
function formatApiError(err: MnemoApiError, container: string | undefined): string {
  if (err.status === 403) {
    return container
      ? `Container '${container}' is not in this connection's allowed set.`
      : "This request is outside this connection's allowed container set."
  }
  if (err.status === 400 && container === undefined && /container/i.test(err.message)) {
    return 'This connection covers multiple containers — pass `container` to target one (e.g. when adding a memory).'
  }
  return `Mnemo API error (${err.status}): ${err.message}`
}

async function dispatch(
  api: MnemoApiClient,
  name: string,
  raw: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const i = SearchInput.parse(raw)
      return api.search({ query: i.query, limit: i.limit, container: i.container })
    }
    case 'memory_add': {
      const i = AddInput.parse(raw)
      return api.addMemory({
        content: i.content,
        memoryType: i.memoryType,
        metadata: i.metadata,
        source: i.source,
        idempotencyKey: i.idempotencyKey,
        container: i.container,
      })
    }
    case 'memory_update': {
      const i = UpdateInput.parse(raw)
      return api.updateMemory(
        i.id,
        {
          content: i.content,
          memoryType: i.memoryType,
          metadata: i.metadata,
          source: i.source,
        },
        i.container,
      )
    }
    case 'memory_get': {
      const i = GetInput.parse(raw)
      return api.getMemory(i.id, i.container)
    }
    case 'memory_delete': {
      const i = DeleteInput.parse(raw)
      return api.deleteMemory(i.id, i.container)
    }
    case 'memory_list': {
      const i = ListInput.parse(raw)
      return api.listMemories({ limit: i.limit, cursor: i.cursor, container: i.container })
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
  }
}
