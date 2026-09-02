import { request } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpHttpServer, pinnedContainerFromGrant } from './http.js'

function call(port: number, options: { method: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/mcp', ...options }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

describe('hosted MCP HTTP entry point', () => {
  it('requires a configured tenant boundary', async () => {
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const result = await call(address.port, {
      method: 'POST',
      headers: { authorization: 'Bearer test', 'x-getmnemo-workspace-id': 'workspace' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    expect(result.status).toBe(400)
  })

  it('serves a health response without exposing credentials', async () => {
    const server = createMcpHttpServer({ GETMNEMO_CONTAINER_TAG: 'user:test' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    const result = await new Promise<string>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/healthz' }, (res) => {
        let body = ''
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.end()
    })
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    expect(JSON.parse(result)).toEqual({ status: 'ok', service: 'getmnemo-mcp', transport: 'streamable-http' })
  })
})

describe('pinnedContainerFromGrant', () => {
  it('pins exactly-one-container grants', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTags: ['team:acme'] })).toEqual({
      containerTag: 'team:acme',
    })
  })

  it('does NOT pin an "all containers" grant (containerTags: [])', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTag: null, containerTags: [] })).toBeUndefined()
  })

  it('does NOT pin a multi-container grant (length > 1)', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTags: ['a', 'b'] })).toBeUndefined()
  })

  it('falls back to the legacy single containerTag when no array is present', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws', containerTag: 'user:jane' })).toEqual({
      containerTag: 'user:jane',
    })
  })

  it('returns undefined when neither form is present', () => {
    expect(pinnedContainerFromGrant({ tenantId: 'ws' })).toBeUndefined()
  })
})

describe('hosted OAuth session establishment', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // A JWT-shaped credential (3 dot-separated segments) routes to the OAuth
  // /introspect branch. We stub global fetch so introspect returns the grant.
  function stubIntrospect(identity: Record<string, unknown>): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify(identity), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
  }

  async function initialize(port: number): Promise<{ status: number; body: string }> {
    return call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    }).then((r) => ({ status: r.status, body: r.body }))
  }

  it('establishes a session for an "all containers" grant (workspaceId only, no pinned container)', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTag: null, containerTags: [] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    // Would have been 400 "no valid workspace/container scope" before the fix.
    expect(result.status).toBe(200)
  })

  it('establishes a session for a multi-container grant without pinning', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTags: ['team:a', 'team:b'] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(200)
  })

  async function listTools(port: number): Promise<{ status: number; names: string[] }> {
    const result = await call(port, {
      method: 'POST',
      headers: {
        authorization: 'Bearer header.payload.signature',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    // Stateless transport answers over SSE: pull the JSON-RPC payload out of the data: lines.
    const payloads = result.body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5).trim()) as { result?: { tools?: Array<{ name: string }> } })
    const names = payloads.flatMap((p) => (p.result?.tools ?? []).map((t) => t.name))
    return { status: result.status, names }
  }

  it('hides API-key-only personal tools from an OAuth session over the real transport', async () => {
    stubIntrospect({ tenantId: 'workspace', containerTags: ['user:jane'] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await listTools(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(200)
    expect(result.names).toContain('memory_search')
    expect(result.names).toContain('memory_add')
    expect(result.names).toContain('memory_timeline')
    for (const hidden of [
      'daily_brief',
      'people_list',
      'people_get',
      'people_upsert',
      'reminder_create',
      'reminders_upcoming',
      'reminder_complete',
      'meeting_brief',
      'meetings_upcoming',
      'memory_merge',
    ]) expect(result.names, hidden).not.toContain(hidden)
  })

  it('still rejects an OAuth grant with no workspace scope', async () => {
    stubIntrospect({ containerTags: [] })
    const server = createMcpHttpServer({ GETMNEMO_API_URL: 'https://api.example.com' })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')

    const result = await initialize(address.port)
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))

    expect(result.status).toBe(400)
  })
})
