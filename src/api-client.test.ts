import { describe, expect, it, vi } from 'vitest'
import { MnemoApiClient } from './api-client.js'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
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
})
