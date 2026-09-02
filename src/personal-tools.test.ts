import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createServer } from './server.js'
import { PERSONAL_TOOLS, PERSONAL_TOOL_INFO, slugifyDisplayName } from './personal-tools.js'

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function apiError(status: number, code: string | undefined, message: string): Response {
  return response({ statusCode: status, error: 'Error', ...(code ? { code } : {}), message }, status)
}

type Harness = {
  client: Client
  fetchImpl: FetchMock
  call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>
  close: () => Promise<void>
}

async function harness(
  fetchImpl: FetchMock,
  options: { container?: { containerTag: string }; principal?: 'api_key' | 'oauth' } = { container: { containerTag: 'user:jane' } },
): Promise<Harness> {
  const server = createServer(
    {
      baseUrl: 'https://api.example.com',
      apiKey: 'mnemo_live_test',
      workspaceId: 'workspace',
      ...(options.container ? { container: options.container } : {}),
      fetch: fetchImpl,
    },
    options.principal ? { principal: options.principal } : undefined,
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  return {
    client,
    fetchImpl,
    async call(name, args) {
      const result = await client.callTool({ name, arguments: args })
      const content = result.content as Array<{ type: string; text?: string }>
      return { text: content[0]?.text ?? '', isError: result.isError === true }
    },
    async close() {
      await client.close()
      await server.close()
    },
  }
}

function requestAt(fetchImpl: FetchMock, index: number): { url: URL; init: RequestInit | undefined; body: unknown } {
  const call = fetchImpl.mock.calls[index]
  if (!call) throw new Error(`no fetch call #${index}`)
  const init = call[1]
  return { url: new URL(String(call[0])), init, body: init?.body ? JSON.parse(String(init.body)) : undefined }
}

const NEW_TOOL_NAMES = [
  'daily_brief',
  'memory_timeline',
  'people_list',
  'people_get',
  'people_upsert',
  'reminder_create',
  'reminders_upcoming',
  'reminder_complete',
  'meeting_brief',
  'meetings_upcoming',
  'memory_merge',
]

describe('personal-memory tool registry', () => {
  it('registers every new tool with a JSON schema and a scope hint in its description', () => {
    expect(PERSONAL_TOOLS.map((t) => t.name).sort()).toEqual([...NEW_TOOL_NAMES].sort())
    for (const tool of PERSONAL_TOOLS) {
      const info = PERSONAL_TOOL_INFO[tool.name as keyof typeof PERSONAL_TOOL_INFO]
      expect(info, tool.name).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
      for (const scope of info.scopes) expect(tool.description, tool.name).toContain(scope)
      expect(tool.description, tool.name).toContain(info.envFlag)
    }
  })

  it('lists `container` before content-bearing fields (container-first ordering)', () => {
    for (const tool of PERSONAL_TOOLS) {
      const keys = Object.keys(tool.inputSchema.properties ?? {})
      if (!keys.includes('container')) continue
      expect(keys[0], tool.name).toBe('container')
    }
  })

  it('exposes the new tools alongside the memory tools over MCP', async () => {
    const h = await harness(vi.fn<typeof fetch>())
    const { tools } = await h.client.listTools()
    const names = tools.map((t) => t.name)
    for (const name of [...NEW_TOOL_NAMES, 'memory_search', 'memory_add']) expect(names).toContain(name)
    await h.close()
  })

  it('hides API-key-only tools from hosted OAuth sessions but keeps memory_timeline', async () => {
    const h = await harness(vi.fn<typeof fetch>(), { principal: 'oauth' })
    const { tools } = await h.client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain('memory_timeline')
    expect(names).toContain('memory_search')
    for (const name of NEW_TOOL_NAMES.filter((n) => n !== 'memory_timeline')) expect(names).not.toContain(name)
    await h.close()
  })
})

describe('slugifyDisplayName', () => {
  it('mirrors the API slug rules', () => {
    expect(slugifyDisplayName('José Álvarez')).toBe('jose-alvarez')
    expect(slugifyDisplayName('  Alice   Smith!! ')).toBe('alice-smith')
    expect(slugifyDisplayName('🎉')).toBe('')
    expect(slugifyDisplayName('a'.repeat(70)).length).toBe(64)
  })
})

describe('personal-memory tool dispatch', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  it('daily_brief reads /v1/brief pinned to the configured container', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ date: '2026-09-02', reminders: null }))
    h = await harness(fetchImpl)
    const result = await h.call('daily_brief', { date: '2026-09-02', timezone: 'Asia/Karachi', sections: ['core'] })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toEqual({ date: '2026-09-02', reminders: null })
    const { url } = requestAt(fetchImpl, 0)
    expect(url.pathname).toBe('/v1/brief')
    expect(url.searchParams.get('containerTag')).toBe('user:jane')
    expect(url.searchParams.get('timezone')).toBe('Asia/Karachi')
    expect(url.searchParams.get('sections')).toBe('core')
  })

  it('daily_brief rejects an invalid section name before any network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    h = await harness(fetchImpl)
    const result = await h.call('daily_brief', { sections: ['weather'] })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/Invalid arguments: sections/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('memory_timeline threads types/direction and a per-call container', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null, container: null }))
    h = await harness(fetchImpl)
    const result = await h.call('memory_timeline', { container: 'person:alice', types: ['memory', 'reminder'], direction: 'asc', limit: 5 })
    expect(result.isError).toBe(false)
    const { url, init } = requestAt(fetchImpl, 0)
    expect(url.pathname).toBe('/v1/timeline')
    expect(url.searchParams.get('containerTag')).toBe('person:alice')
    expect(url.searchParams.get('types')).toBe('memory,reminder')
    expect(url.searchParams.get('direction')).toBe('asc')
    expect(url.searchParams.get('limit')).toBe('5')
    expect((init?.headers as Record<string, string>)['x-mnemo-container']).toBe('person:alice')
  })

  it('people_list / people_get map to /v1/people', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [{ slug: 'alice' }], nextCursor: null, total: 1 }))
      .mockResolvedValueOnce(response({ slug: 'alice', displayName: 'Alice' }))
    h = await harness(fetchImpl)
    const list = await h.call('people_list', { q: 'ali', includeArchived: true })
    expect(JSON.parse(list.text).total).toBe(1)
    const listUrl = requestAt(fetchImpl, 0).url
    expect(listUrl.pathname).toBe('/v1/people')
    expect(listUrl.searchParams.get('q')).toBe('ali')
    expect(listUrl.searchParams.get('includeArchived')).toBe('true')

    const get = await h.call('people_get', { slug: 'alice' })
    expect(JSON.parse(get.text).displayName).toBe('Alice')
    expect(requestAt(fetchImpl, 1).url.pathname).toBe('/v1/people/alice')
  })

  it('people_upsert creates when the person does not exist yet', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ slug: 'alice-smith', displayName: 'Alice Smith' }, 201))
    h = await harness(fetchImpl)
    const result = await h.call('people_upsert', { displayName: 'Alice Smith', email: 'Alice@x.io', importantDates: [{ label: 'Birthday', date: '1990-05-01', recurring: true }] })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toEqual({ created: true, person: { slug: 'alice-smith', displayName: 'Alice Smith' } })
    const { url, init, body } = requestAt(fetchImpl, 0)
    expect(url.pathname).toBe('/v1/people')
    expect(init?.method).toBe('POST')
    expect(body).toEqual({ displayName: 'Alice Smith', email: 'Alice@x.io', importantDates: [{ label: 'Birthday', date: '1990-05-01', recurring: true }] })
  })

  it('people_upsert falls back to PATCH on 409 PERSON_EXISTS using the derived slug', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiError(409, 'PERSON_EXISTS', 'A person with slug alice-smith already exists.'))
      .mockResolvedValueOnce(response({ slug: 'alice-smith', company: 'Acme' }))
    h = await harness(fetchImpl)
    const result = await h.call('people_upsert', { displayName: 'Alice Smith', company: 'Acme' })
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.text)).toEqual({ created: false, person: { slug: 'alice-smith', company: 'Acme' } })
    const patch = requestAt(fetchImpl, 1)
    expect(patch.url.pathname).toBe('/v1/people/alice-smith')
    expect(patch.init?.method).toBe('PATCH')
    // The slug is immutable and displayName is only re-sent when it changes the record.
    expect(patch.body).toEqual({ displayName: 'Alice Smith', company: 'Acme' })
  })

  it('people_upsert with an explicit slug patches first and creates on 404', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiError(404, 'PERSON_NOT_FOUND', 'No such person.'))
      .mockResolvedValueOnce(response({ slug: 'al', displayName: 'Alice' }, 201))
    h = await harness(fetchImpl)
    const result = await h.call('people_upsert', { slug: 'al', displayName: 'Alice' })
    expect(JSON.parse(result.text)).toEqual({ created: true, person: { slug: 'al', displayName: 'Alice' } })
    expect(requestAt(fetchImpl, 0).init?.method).toBe('PATCH')
    expect(requestAt(fetchImpl, 0).url.pathname).toBe('/v1/people/al')
    const create = requestAt(fetchImpl, 1)
    expect(create.init?.method).toBe('POST')
    expect(create.body).toEqual({ slug: 'al', displayName: 'Alice' })
  })

  it('people_upsert refuses a displayName that yields no slug', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    h = await harness(fetchImpl)
    const result = await h.call('people_upsert', { displayName: '🎉' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/slug/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reminder_create files under a person, and rejects personSlug + container together', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'r1', dueAt: '2026-09-15T09:00:00.000Z' }, 201))
    h = await harness(fetchImpl)
    const ok = await h.call('reminder_create', { content: 'Send proposal', dueAt: '2026-09-15T09:00:00Z', personSlug: 'alice' })
    expect(ok.isError).toBe(false)
    expect(requestAt(fetchImpl, 0).body).toEqual({ content: 'Send proposal', dueAt: '2026-09-15T09:00:00Z', personSlug: 'alice' })

    const both = await h.call('reminder_create', { content: 'x', dueAt: '2026-09-15T09:00:00Z', personSlug: 'alice', container: 'project:a' })
    expect(both.isError).toBe(true)
    expect(both.text).toMatch(/personSlug/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('reminder_create rejects a non-ISO dueAt before any network call', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    h = await harness(fetchImpl)
    const result = await h.call('reminder_create', { content: 'x', dueAt: 'next tuesday' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/dueAt/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reminders_upcoming and reminder_complete hit the reminder routes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ overdue: [], dueToday: [], upcoming: [], importantDates: [], generatedAt: 'x', timezone: 'UTC' }))
      .mockResolvedValueOnce(response({ id: 'r1', dueAt: null, completedAt: 'now' }))
    h = await harness(fetchImpl)
    await h.call('reminders_upcoming', { days: 14, timezone: 'UTC' })
    const up = requestAt(fetchImpl, 0).url
    expect(up.pathname).toBe('/v1/reminders/upcoming')
    expect(up.searchParams.get('days')).toBe('14')
    expect(up.searchParams.has('containerTag')).toBe(false)

    const done = await h.call('reminder_complete', { id: 'r1' })
    expect(JSON.parse(done.text).completedAt).toBe('now')
    expect(requestAt(fetchImpl, 1).url.pathname).toBe('/v1/reminders/r1/complete')
    expect(requestAt(fetchImpl, 1).init?.method).toBe('POST')
  })

  it('meetings_upcoming and meeting_brief hit the meeting routes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ items: [], nextCursor: null, connections: [] }))
      .mockResolvedValueOnce(response({ documentId: 'd1', brief: null }))
    h = await harness(fetchImpl)
    await h.call('meetings_upcoming', { days: 2 })
    expect(requestAt(fetchImpl, 0).url.pathname).toBe('/v1/meetings/upcoming')
    expect(requestAt(fetchImpl, 0).url.searchParams.get('days')).toBe('2')

    await h.call('meeting_brief', { documentId: 'd1', q: 'what is open?' })
    const brief = requestAt(fetchImpl, 1).url
    expect(brief.pathname).toBe('/v1/meetings/d1/brief')
    expect(brief.searchParams.get('q')).toBe('what is open?')
  })

  it('memory_merge posts to /v1/memories/merge with the effective container', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ memory: { id: 'a' }, mergedFromIds: ['b'], deletedIds: ['b'], replayed: false }))
    h = await harness(fetchImpl)
    const result = await h.call('memory_merge', { ids: ['a', 'b'], into: 'a', mergeKey: 'k' })
    expect(result.isError).toBe(false)
    const { url, body } = requestAt(fetchImpl, 0)
    expect(url.pathname).toBe('/v1/memories/merge')
    expect(body).toEqual({ ids: ['a', 'b'], into: 'a', mergeKey: 'k', containerTag: 'user:jane' })
  })

  it('memory_merge requires content when no survivor is kept, and 2..20 unique ids', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    h = await harness(fetchImpl)
    const noContent = await h.call('memory_merge', { ids: ['a', 'b'] })
    expect(noContent.isError).toBe(true)
    expect(noContent.text).toMatch(/content/)
    const dupes = await h.call('memory_merge', { ids: ['a', 'a'], content: 'x' })
    expect(dupes.isError).toBe(true)
    expect(dupes.text).toMatch(/ids/)
    const intoOutside = await h.call('memory_merge', { ids: ['a', 'b'], into: 'c' })
    expect(intoOutside.isError).toBe(true)
    expect(intoOutside.text).toMatch(/into/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('personal-memory error mapping', () => {
  let h: Harness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  it('names the MEMORY_API_* flag on 503 FEATURE_DISABLED', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(503, 'FEATURE_DISABLED', 'people is not enabled for this deployment.')))
    const result = await h.call('people_list', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('MEMORY_API_PEOPLE_ENABLED')
    expect(result.text).toContain('FEATURE_DISABLED')
  })

  it('maps each tool to its own flag', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => apiError(503, 'FEATURE_DISABLED', 'disabled'))
    h = await harness(fetchImpl)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['daily_brief', {}, 'MEMORY_API_BRIEF_ENABLED'],
      ['memory_timeline', {}, 'MEMORY_API_TIMELINE_ENABLED'],
      ['reminders_upcoming', {}, 'MEMORY_API_PEOPLE_ENABLED'],
      ['meetings_upcoming', {}, 'MEMORY_API_MEETINGS_ENABLED'],
      ['memory_merge', { ids: ['a', 'b'], content: 'x' }, 'MEMORY_API_INBOX_ENABLED'],
    ]
    for (const [name, args, flag] of cases) {
      const result = await h.call(name, args)
      expect(result.isError, name).toBe(true)
      expect(result.text, name).toContain(flag)
    }
  })

  it('explains that hosted OAuth tokens cannot use API-key-only tools', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(403, undefined, 'access_denied: this operation is not available to MCP tokens')))
    const result = await h.call('people_list', {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/API key/)
    expect(result.text).toContain('people:read')
  })

  it('names the missing scope on a 403 scope rejection', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(403, undefined, 'Key missing required scope(s): reminders:write')))
    const result = await h.call('reminder_complete', { id: 'r1' })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('reminders:write')
  })

  it('surfaces stable error codes (404 PERSON_NOT_FOUND, 400 NOT_A_REMINDER, 403 MERGE_PROTECTED)', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiError(404, 'PERSON_NOT_FOUND', 'No such person.'))
      .mockResolvedValueOnce(apiError(400, 'NOT_A_REMINDER', 'Memory r1 is not a reminder.'))
      .mockResolvedValueOnce(apiError(403, 'MERGE_PROTECTED', 'A protected memory cannot be merged.'))
    h = await harness(fetchImpl)
    const missing = await h.call('people_get', { slug: 'nobody' })
    expect(missing.text).toContain('404 PERSON_NOT_FOUND')
    expect(missing.text).toContain('No such person.')
    const notReminder = await h.call('reminder_complete', { id: 'r1' })
    expect(notReminder.text).toContain('400 NOT_A_REMINDER')
    const protectedMerge = await h.call('memory_merge', { ids: ['a', 'b'], into: 'a' })
    expect(protectedMerge.text).toContain('403 MERGE_PROTECTED')
  })

  it('asks for `container` on 400 CONTAINER_TAG_REQUIRED when none was configured', async () => {
    h = await harness(
      vi.fn<typeof fetch>().mockResolvedValue(apiError(400, 'CONTAINER_TAG_REQUIRED', 'A containerTag or scope is required for API keys.')),
      { container: undefined },
    )
    const result = await h.call('daily_brief', {})
    expect(result.isError).toBe(true)
    expect(result.text).toContain('`container`')
  })

  it('keeps the memory tools on the original container-scope wording', async () => {
    h = await harness(vi.fn<typeof fetch>().mockResolvedValue(apiError(403, undefined, 'container not allowed')))
    const result = await h.call('memory_search', { query: 'hi', container: 'team:forbidden' })
    expect(result.text).toBe("Container 'team:forbidden' is not in this connection's allowed set.")
  })
})
