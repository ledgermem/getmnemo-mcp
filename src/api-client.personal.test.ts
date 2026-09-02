import { describe, expect, it, vi } from 'vitest'
import { CONTAINER_HEADER, MnemoApiClient } from './api-client.js'

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

function client(fetchImpl: typeof fetch, container?: { containerTag: string }): MnemoApiClient {
  return new MnemoApiClient({
    baseUrl: 'https://api.example.com',
    apiKey: 'mnemo_live_test',
    workspaceId: 'workspace',
    ...(container ? { container } : {}),
    fetch: fetchImpl,
  })
}

function lastCall(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): { url: string; init: RequestInit | undefined } {
  const call = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1]
  if (!call) throw new Error('no fetch call recorded')
  return { url: String(call[0]), init: call[1] }
}

describe('MnemoApiClient personal-memory surface', () => {
  describe('getDailyBrief', () => {
    it('pins the configured container and threads the day/timezone/sections query', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ date: '2026-09-02' }))
      await client(fetchImpl, { containerTag: 'user:jane' }).getDailyBrief({
        date: '2026-09-02',
        timezone: 'America/New_York',
        days: 3,
        sections: ['core', 'meetings'],
      })
      const { url, init } = lastCall(fetchImpl)
      expect(init?.method).toBe('GET')
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/v1/brief')
      expect(parsed.searchParams.get('containerTag')).toBe('user:jane')
      expect(parsed.searchParams.get('date')).toBe('2026-09-02')
      expect(parsed.searchParams.get('timezone')).toBe('America/New_York')
      expect(parsed.searchParams.get('days')).toBe('3')
      expect(parsed.searchParams.get('sections')).toBe('core,meetings')
      expect(init?.body).toBeUndefined()
      expect(headerOf(init, CONTAINER_HEADER)).toBeUndefined()
    })

    it('lets a per-call container override the default and sends the container header', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ date: '2026-09-02' }))
      await client(fetchImpl, { containerTag: 'user:jane' }).getDailyBrief({ container: 'person:alice' })
      const { url, init } = lastCall(fetchImpl)
      expect(new URL(url).searchParams.get('containerTag')).toBe('person:alice')
      expect(headerOf(init, CONTAINER_HEADER)).toBe('person:alice')
    })

    it('sends no container filter when neither default nor override exists (hosted grant)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ date: '2026-09-02' }))
      await client(fetchImpl).getDailyBrief({})
      const { url } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/brief')
    })
  })

  describe('getTimeline', () => {
    it('builds the timeline query with types csv, bounds, direction and pagination', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null }))
      await client(fetchImpl, { containerTag: 'user:jane' }).getTimeline({
        from: '2026-08-01T00:00:00Z',
        to: '2026-09-01T00:00:00Z',
        types: ['memory', 'event'],
        direction: 'asc',
        limit: 10,
        cursor: 'abc',
      })
      const { url, init } = lastCall(fetchImpl)
      expect(init?.method).toBe('GET')
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/v1/timeline')
      expect(parsed.searchParams.get('containerTag')).toBe('user:jane')
      expect(parsed.searchParams.get('from')).toBe('2026-08-01T00:00:00Z')
      expect(parsed.searchParams.get('to')).toBe('2026-09-01T00:00:00Z')
      expect(parsed.searchParams.get('types')).toBe('memory,event')
      expect(parsed.searchParams.get('direction')).toBe('asc')
      expect(parsed.searchParams.get('limit')).toBe('10')
      expect(parsed.searchParams.get('cursor')).toBe('abc')
    })

    it('uses structured scope params when the default boundary is a scope', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }))
      const api = new MnemoApiClient({
        baseUrl: 'https://api.example.com',
        apiKey: 'k',
        workspaceId: 'w',
        container: { scope: { type: 'user', id: 'jane' } },
        fetch: fetchImpl,
      })
      await api.getTimeline({})
      const parsed = new URL(lastCall(fetchImpl).url)
      expect(parsed.searchParams.get('scopeType')).toBe('user')
      expect(parsed.searchParams.get('scopeId')).toBe('jane')
      expect(parsed.searchParams.has('containerTag')).toBe(false)
    })
  })

  describe('people', () => {
    it('lists people with q / includeArchived as string booleans / pagination', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null, total: 0 }))
      await client(fetchImpl, { containerTag: 'user:jane' }).listPeople({ q: 'ali', includeArchived: true, limit: 5, cursor: 'c1' })
      const { url, init } = lastCall(fetchImpl)
      const parsed = new URL(url)
      expect(parsed.pathname).toBe('/v1/people')
      expect(parsed.searchParams.get('q')).toBe('ali')
      expect(parsed.searchParams.get('includeArchived')).toBe('true')
      expect(parsed.searchParams.get('limit')).toBe('5')
      expect(parsed.searchParams.get('cursor')).toBe('c1')
      // People are cross-container: the default container must NOT leak in.
      expect(parsed.searchParams.has('containerTag')).toBe(false)
      expect(headerOf(init, CONTAINER_HEADER)).toBeUndefined()
    })

    it('fetches a person by url-encoded slug', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ slug: 'alice' }))
      await client(fetchImpl).getPerson('alice smith')
      expect(lastCall(fetchImpl).url).toBe('https://api.example.com/v1/people/alice%20smith')
    })

    it('creates a person with only the provided fields', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ slug: 'alice' }, 201))
      await client(fetchImpl).createPerson({ displayName: 'Alice', email: 'a@x.io', aliases: ['Al'] })
      const { url, init } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/people')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ displayName: 'Alice', email: 'a@x.io', aliases: ['Al'] })
    })

    it('patches a person and preserves explicit nulls (clear a field)', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ slug: 'alice' }))
      await client(fetchImpl).updatePerson('alice', { company: null, notes: 'x' })
      const { url, init } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/people/alice')
      expect(init?.method).toBe('PATCH')
      expect(JSON.parse(String(init?.body))).toEqual({ company: null, notes: 'x' })
    })
  })

  describe('reminders', () => {
    it('creates a reminder in a person container', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'r1' }, 201))
      await client(fetchImpl, { containerTag: 'user:jane' }).createReminder({
        content: 'Send the proposal',
        dueAt: '2026-09-15T09:00:00Z',
        personSlug: 'alice',
        idempotencyKey: 'crm-42',
      })
      const { url, init } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/reminders')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        content: 'Send the proposal',
        dueAt: '2026-09-15T09:00:00Z',
        personSlug: 'alice',
        idempotencyKey: 'crm-42',
      })
    })

    it('falls back to the configured container when no target is given', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'r1' }, 201))
      await client(fetchImpl, { containerTag: 'user:jane' }).createReminder({ content: 'x', dueAt: '2026-09-15T09:00:00Z' })
      expect(JSON.parse(String(lastCall(fetchImpl).init?.body))).toEqual({
        content: 'x',
        dueAt: '2026-09-15T09:00:00Z',
        containerTag: 'user:jane',
      })
    })

    it('targets an explicit container with the container header', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'r1' }, 201))
      await client(fetchImpl, { containerTag: 'user:jane' }).createReminder({ content: 'x', dueAt: '2026-09-15T09:00:00Z', container: 'project:alpha' })
      const { init } = lastCall(fetchImpl)
      expect(JSON.parse(String(init?.body))).toMatchObject({ containerTag: 'project:alpha' })
      expect(headerOf(init, CONTAINER_HEADER)).toBe('project:alpha')
    })

    it('lists upcoming reminders workspace-wide unless a container filter is given', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ overdue: [], dueToday: [], upcoming: [] }))
      const api = client(fetchImpl, { containerTag: 'user:jane' })
      await api.listUpcomingReminders({ days: 14, timezone: 'Asia/Karachi', containerType: 'person', limit: 20 })
      let parsed = new URL(lastCall(fetchImpl).url)
      expect(parsed.pathname).toBe('/v1/reminders/upcoming')
      expect(parsed.searchParams.get('days')).toBe('14')
      expect(parsed.searchParams.get('timezone')).toBe('Asia/Karachi')
      expect(parsed.searchParams.get('containerType')).toBe('person')
      expect(parsed.searchParams.get('limit')).toBe('20')
      expect(parsed.searchParams.has('containerTag')).toBe(false)

      await api.listUpcomingReminders({ container: 'person:alice' })
      parsed = new URL(lastCall(fetchImpl).url)
      expect(parsed.searchParams.get('containerTag')).toBe('person:alice')
    })

    it('completes a reminder with an empty POST', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ id: 'r1', dueAt: null }))
      await client(fetchImpl).completeReminder('r1')
      const { url, init } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/reminders/r1/complete')
      expect(init?.method).toBe('POST')
      expect(init?.body).toBeUndefined()
    })
  })

  describe('meetings', () => {
    it('lists upcoming meetings with the window and optional calendar container', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [], nextCursor: null, connections: [] }))
      await client(fetchImpl, { containerTag: 'user:jane' }).listUpcomingMeetings({ days: 3, limit: 10, cursor: 'c', container: 'calendar:me@x.io' })
      const parsed = new URL(lastCall(fetchImpl).url)
      expect(parsed.pathname).toBe('/v1/meetings/upcoming')
      expect(parsed.searchParams.get('days')).toBe('3')
      expect(parsed.searchParams.get('limit')).toBe('10')
      expect(parsed.searchParams.get('cursor')).toBe('c')
      expect(parsed.searchParams.get('containerTag')).toBe('calendar:me@x.io')
    })

    it('does not leak the default container into the meetings list', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ items: [] }))
      await client(fetchImpl, { containerTag: 'user:jane' }).listUpcomingMeetings({})
      expect(lastCall(fetchImpl).url).toBe('https://api.example.com/v1/meetings/upcoming')
    })

    it('fetches a meeting brief with an optional question', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ documentId: 'd1' }))
      const api = client(fetchImpl)
      await api.getMeetingBrief('d1')
      expect(lastCall(fetchImpl).url).toBe('https://api.example.com/v1/meetings/d1/brief')
      await api.getMeetingBrief('d1', 'what is open?')
      expect(new URL(lastCall(fetchImpl).url).searchParams.get('q')).toBe('what is open?')
    })
  })

  describe('mergeMemories', () => {
    it('posts ids + survivor options with the effective container', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ memory: { id: 'a' }, mergedFromIds: ['b'], deletedIds: ['b'], replayed: false }))
      await client(fetchImpl, { containerTag: 'user:jane' }).mergeMemories({
        ids: ['a', 'b'],
        into: 'a',
        metadata: { reviewed: true },
        mergeKey: 'k1',
      })
      const { url, init } = lastCall(fetchImpl)
      expect(url).toBe('https://api.example.com/v1/memories/merge')
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({
        ids: ['a', 'b'],
        into: 'a',
        metadata: { reviewed: true },
        mergeKey: 'k1',
        containerTag: 'user:jane',
      })
    })

    it('overrides the container per call with the header', async () => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ memory: { id: 'n' } }))
      await client(fetchImpl, { containerTag: 'user:jane' }).mergeMemories({ ids: ['a', 'b'], content: 'merged', container: 'team:acme' })
      const { init } = lastCall(fetchImpl)
      expect(JSON.parse(String(init?.body))).toEqual({ ids: ['a', 'b'], content: 'merged', containerTag: 'team:acme' })
      expect(headerOf(init, CONTAINER_HEADER)).toBe('team:acme')
    })
  })

  it('exposes the stable error code from the API envelope', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response({ statusCode: 503, error: 'Service Unavailable', code: 'FEATURE_DISABLED', message: 'people is not enabled for this deployment.' }, 503),
    )
    await expect(client(fetchImpl).getPerson('alice')).rejects.toMatchObject({
      status: 503,
      code: 'FEATURE_DISABLED',
      message: 'people is not enabled for this deployment.',
    })
  })
})
