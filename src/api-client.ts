/**
 * Thin REST client for the Mnemo Memory API.
 *
 * This duplicates the surface area we need for MCP tools — we deliberately
 * do NOT depend on @getmnemo/memory here so this server can ship even if
 * the JS SDK lags behind. When the SDK stabilises, swap this for it.
 */

export type Memory = {
  id: string
  content: string
  metadata?: Record<string, unknown>
  workspaceId: string
  actorId?: string | null
  createdAt: string
  updatedAt: string
}

export type SearchHit = {
  memoryId: string
  content: string
  score: number
  metadata?: Record<string, unknown>
  source?: { documentId?: string; chunkId?: string } | null
}

export type SearchResponse = {
  hits: SearchHit[]
  query: string
  latencyMs: number
}

export type ApiClientConfig = {
  baseUrl: string
  apiKey: string
  workspaceId: string
  actorId?: string
  fetch?: typeof fetch
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number
}

export class MnemoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MnemoApiError'
  }
}

export class MnemoApiClient {
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(cfg: ApiClientConfig) {
    if (!cfg.apiKey) throw new Error('apiKey is required')
    if (!cfg.workspaceId) throw new Error('workspaceId is required')
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    this.headers = {
      'authorization': `Bearer ${cfg.apiKey}`,
      'x-workspace-id': cfg.workspaceId,
      'content-type': 'application/json',
      'user-agent': '@getmnemo/mcp-server',
      ...(cfg.actorId ? { 'x-actor-id': cfg.actorId } : {}),
    }
    this.fetchImpl = cfg.fetch ?? fetch
    this.timeoutMs = cfg.timeoutMs ?? 30_000
  }

  async search(input: {
    query: string
    limit?: number
    actorId?: string
  }): Promise<SearchResponse> {
    return this.request<SearchResponse>('POST', '/v1/search', {
      query: input.query,
      limit: input.limit ?? 8,
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    })
  }

  async addMemory(input: {
    content: string
    metadata?: Record<string, unknown>
    actorId?: string
  }): Promise<Memory> {
    return this.request<Memory>('POST', '/v1/memories', {
      content: input.content,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.actorId !== undefined ? { actorId: input.actorId } : {}),
    })
  }

  async updateMemory(
    id: string,
    input: { content?: string; metadata?: Record<string, unknown> },
  ): Promise<Memory> {
    return this.request<Memory>('PATCH', `/v1/memories/${encodeURIComponent(id)}`, input)
  }

  async deleteMemory(id: string): Promise<{ id: string; deleted: true }> {
    return this.request<{ id: string; deleted: true }>(
      'DELETE',
      `/v1/memories/${encodeURIComponent(id)}`,
    )
  }

  async listMemories(input?: {
    limit?: number
    cursor?: string
    actorId?: string
  }): Promise<{ items: Memory[]; nextCursor: string | null }> {
    const params = new URLSearchParams()
    if (input?.limit !== undefined) params.set('limit', String(input.limit))
    if (input?.cursor !== undefined) params.set('cursor', input.cursor)
    if (input?.actorId !== undefined) params.set('actorId', input.actorId)
    const qs = params.toString()
    return this.request('GET', `/v1/memories${qs ? `?${qs}` : ''}`)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { ...this.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      const parsed = text ? safeJson(text) : undefined
      if (!res.ok) {
        const msg =
          (parsed && typeof parsed === 'object' && 'message' in parsed
            ? String((parsed as { message: unknown }).message)
            : null) ?? `HTTP ${res.status} ${res.statusText}`
        throw new MnemoApiError(msg, res.status, parsed)
      }
      if (parsed !== undefined && typeof parsed !== 'object') {
        throw new MnemoApiError(
          `Expected JSON object response, got: ${typeof parsed}`,
          res.status,
          parsed,
        )
      }
      return parsed as T
    } finally {
      clearTimeout(timer)
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}
