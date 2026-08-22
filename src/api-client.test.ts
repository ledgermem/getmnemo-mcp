import { describe, expect, it, vi } from 'vitest'
import { CONTAINER_HEADER, MnemoApiClient, MnemoApiError } from './api-client.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.[name]
}

describe('MnemoApiClient', () => {
  it('forwards provenance, type, and idempotency on writes', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:test' },
      fetch: fetchImpl,
    })

    await client.addMemory({
      content: 'The user prefers dark mode.',
      memoryType: 'preference',
      source: { kind: 'conversation', id: 'turn-1' },
      idempotencyKey: 'turn-1:preference',
    })

    const [, init] = fetchImpl.mock.calls[0] ?? []
    expect(JSON.parse(String(init?.body))).toMatchObject({
      containerTag: 'user:test',
      items: [{ memoryType: 'preference', source: { kind: 'conversation', id: 'turn-1' }, idempotencyKey: 'turn-1:preference' }],
    })
  })

  it('supports direct get and tenant-pinned list requests', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response({ id: 'memory-1' }))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:test' },
      fetch: fetchImpl,
    })

    await client.getMemory('memory-1')
    await client.listMemories({ limit: 10 })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/v1/memories/memory-1?containerTag=user%3Atest')
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('containerTag=user%3Atest')
  })

  it('pins updates and deletes to the configured container', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response({ id: 'memory-1', deleted: true }))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:test' },
      fetch: fetchImpl,
    })

    await client.updateMemory('memory-1', { content: 'updated' })
    await client.deleteMemory('memory-1')

    expect(fetchImpl.mock.calls[0]?.[0]).toContain('containerTag=user%3Atest')
    expect(fetchImpl.mock.calls[1]?.[0]).toContain('containerTag=user%3Atest')
  })

  it('omits the container header when no per-call container is given', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ results: [] }))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:test' },
      fetch: fetchImpl,
    })

    await client.search({ query: 'hello' })

    const [, init] = fetchImpl.mock.calls[0] ?? []
    expect(headerOf(init, CONTAINER_HEADER)).toBeUndefined()
  })

  it('sends the container header and overrides body/query when a per-call container is given', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ results: [], items: [] }))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:default' },
      fetch: fetchImpl,
    })

    await client.search({ query: 'hello', container: 'team:acme' })
    await client.addMemory({ content: 'a fact', container: 'team:acme' })
    await client.getMemory('memory-1', 'team:acme')

    // search: header set, body containerTag overridden to the per-call value.
    const [, searchInit] = fetchImpl.mock.calls[0] ?? []
    expect(headerOf(searchInit, CONTAINER_HEADER)).toBe('team:acme')
    expect(JSON.parse(String(searchInit?.body))).toMatchObject({ containerTag: 'team:acme' })

    // add: header set, body containerTag overridden.
    const [, addInit] = fetchImpl.mock.calls[1] ?? []
    expect(headerOf(addInit, CONTAINER_HEADER)).toBe('team:acme')
    expect(JSON.parse(String(addInit?.body))).toMatchObject({ containerTag: 'team:acme' })

    // get: header set, query pinned to the per-call value.
    const [getUrl, getInit] = fetchImpl.mock.calls[2] ?? []
    expect(headerOf(getInit, CONTAINER_HEADER)).toBe('team:acme')
    expect(String(getUrl)).toContain('containerTag=team%3Aacme')
  })

  it('tolerates an unset default container (hosted all/multi grant)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ results: [], items: [], nextCursor: null }))
    // No `container` in config — allowed in hosted OAuth mode.
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      fetch: fetchImpl,
    })

    // Search with no per-call container: no containerTag in body, no header —
    // the API resolves scope from the grant.
    await expect(client.search({ query: 'hello' })).resolves.toBeDefined()
    const [, searchInit] = fetchImpl.mock.calls[0] ?? []
    expect(JSON.parse(String(searchInit?.body))).not.toHaveProperty('containerTag')
    expect(headerOf(searchInit, CONTAINER_HEADER)).toBeUndefined()

    // List with no per-call container: no container filter in the query string.
    await client.listMemories({ limit: 5 })
    expect(String(fetchImpl.mock.calls[1]?.[0])).not.toContain('containerTag')

    // A per-call container still targets a specific one via header + body.
    await client.addMemory({ content: 'x', container: 'team:acme' })
    const [, addInit] = fetchImpl.mock.calls[2] ?? []
    expect(headerOf(addInit, CONTAINER_HEADER)).toBe('team:acme')
    expect(JSON.parse(String(addInit?.body))).toMatchObject({ containerTag: 'team:acme' })
  })

  it('surfaces API errors with status for container-scope rejections', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ message: 'container not allowed' }, 403))
    const client = new MnemoApiClient({
      baseUrl: 'https://api.example.com',
      apiKey: 'prfly_live_test',
      workspaceId: 'workspace',
      container: { containerTag: 'user:default' },
      fetch: fetchImpl,
    })

    await expect(client.search({ query: 'hi', container: 'team:forbidden' })).rejects.toMatchObject({
      status: 403,
    })
    await expect(client.search({ query: 'hi' })).rejects.toBeInstanceOf(MnemoApiError)
  })
})
