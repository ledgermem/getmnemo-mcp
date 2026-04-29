/**
 * MCP server factory.
 *
 * Exposes 5 tools to MCP clients (Claude Desktop, Cursor, Windsurf, VS Code,
 * Zed): memory_search, memory_add, memory_update, memory_delete, memory_list.
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

const SearchInput = z.object({
  query: z.string().min(1).max(2000).describe('Natural-language search query.'),
  limit: z.number().int().min(1).max(50).default(8).describe('Max number of memories to return.'),
  actor_id: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe('Optional actor scope (defaults to the configured actor).'),
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
  metadata: boundedMetadata
    .optional()
    .describe('Arbitrary JSON metadata (tags, source, etc.). Max 16KB serialized.'),
  actor_id: z.string().min(1).max(256).optional(),
})

const UpdateInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID returned by memory_add or memory_search.'),
  content: z.string().min(1).max(10_000).optional(),
  metadata: boundedMetadata.optional(),
})

const DeleteInput = z.object({
  id: z.string().min(1).max(256).describe('Memory ID to delete.'),
})

const ListInput = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1024).optional(),
  actor_id: z.string().min(1).max(256).optional(),
})

const TOOLS: Tool[] = [
  {
    name: 'memory_search',
    description:
      'Search the Mnemo memory store for facts relevant to a query. Returns ranked hits with content, score, and source citations. Use this BEFORE answering any question that might require remembered context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 8 },
        actor_id: { type: 'string' },
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
        actor_id: { type: 'string' },
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
      properties: { id: { type: 'string' } },
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
        actor_id: { type: 'string' },
      },
    },
  },
]

export function createServer(cfg: ApiClientConfig): Server {
  const api = new MnemoApiClient(cfg)
  const server = new Server(
    { name: 'getmnemo', version: '0.1.0' },
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
          ? `Mnemo API error (${err.status}): ${err.message}`
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

async function dispatch(
  api: MnemoApiClient,
  name: string,
  raw: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'memory_search': {
      const i = SearchInput.parse(raw)
      return api.search({ query: i.query, limit: i.limit, actorId: i.actor_id })
    }
    case 'memory_add': {
      const i = AddInput.parse(raw)
      return api.addMemory({ content: i.content, metadata: i.metadata, actorId: i.actor_id })
    }
    case 'memory_update': {
      const i = UpdateInput.parse(raw)
      return api.updateMemory(i.id, { content: i.content, metadata: i.metadata })
    }
    case 'memory_delete': {
      const i = DeleteInput.parse(raw)
      return api.deleteMemory(i.id)
    }
    case 'memory_list': {
      const i = ListInput.parse(raw)
      return api.listMemories({ limit: i.limit, cursor: i.cursor, actorId: i.actor_id })
    }
    default:
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`)
  }
}
