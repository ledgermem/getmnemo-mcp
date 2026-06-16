/**
 * Thin REST client for the Mnemo Memory API.
 *
 * This duplicates the surface area we need for MCP tools — we deliberately
 * do NOT depend on getmnemo here so this server can ship even if
 * the JS SDK lags behind. When the SDK stabilises, swap this for it.
 *
 * Contract pinned to the prod OpenAPI spec ("Mnemo API" v0.2.0,
 * https://api.mnemohq.com/openapi.json). See SDK_RECONCILIATION_0.2.0.md.
 *
 * SECURITY: the tenant boundary (`containerTag` or structured `scope`) is
 * supplied once at construction from SERVER CONFIG/ENV — it is NOT a
 * per-call argument the model can set. Every request is pinned to the
 * configured container; callers only provide content/query.
 */

// confirmed against prod 2026-06-16. Shapes verified from real /v1 payloads.
export type Memory = {
  id: string
  scope?: unknown
  scopeKey?: string
  container?: {
    id?: string
    tag?: string
    containerType?: string
    displayName?: string
  }
  content: string
  contentHash?: string
  idempotencyKey?: string
  memoryType?: string
  metadata?: Record<string, unknown>
  source?: string
  sourceDocumentId?: string | null
  eventId?: string | null
  deletedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

// confirmed against prod 2026-06-16. Live search hit shape.
export type SearchHit = {
  resultType?: string
  memoryId: string
  scopeKey?: string
  content: string
  metadata?: Record<string, unknown>
  memoryType?: string
  polarity?: string
  score: number
  createdAt?: string
  updatedAt?: string
}

// confirmed against prod 2026-06-16. Search returns `{ results: [...] }`
// (NOT `hits`), plus preference/constraint buckets and search diagnostics.
export type SearchResponse = {
  results: SearchHit[]
  positivePreferences?: SearchHit[]
  hardConstraints?: SearchHit[]
  searchMode?: string
  queryIntent?: string
  queryIntentConfidence?: number
  abstained?: boolean
  reranked?: boolean
  rawBestVectorSim?: number
  latency?: {
    parallelMs?: number
    strategyMs?: number
    fusionMs?: number
    rerankerMs?: number
    totalMs?: number
  }
}

// confirmed against prod 2026-06-16. Add response envelope.
export type AddResponse = {
  scopeKey?: string
  scope?: unknown
  items: Memory[]
}

/**
 * The tenant boundary. Exactly one form is configured server-side:
 *  - `containerTag`: the "user:jane" string form (preferred, simpler), OR
 *  - `scope`: the structured `{ type, id }` form.
 * Both map to the same backend container; we thread whichever is set.
 */
export type ContainerScope =
  | { containerTag: string; scope?: never }
  | { containerTag?: never; scope: { type: string; id: string } }

export type ApiClientConfig = {
  baseUrl: string
  apiKey: string
  workspaceId: string
  /**
   * SERVER-CONFIG tenant boundary. Required. Supplied at server startup
   * (env), never by the model. All add/search/list calls are pinned to it.
   */
  container: ContainerScope
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
  /** Server-configured tenant boundary, threaded into every request. */
  private readonly container: ContainerScope

  constructor(cfg: ApiClientConfig) {
    if (!cfg.apiKey) throw new Error('apiKey is required')
    if (!cfg.workspaceId) throw new Error('workspaceId is required')
    if (!cfg.container || (!cfg.container.containerTag && !cfg.container.scope)) {
      throw new Error('container (containerTag or scope) is required — it is the tenant boundary')
    }
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '')
    this.headers = {
      // Both schemes are REQUIRED per the spec: bearer (prfly_live_* key) +
      // workspace (x-workspace-id header) on every /v1 op.
      'authorization': `Bearer ${cfg.apiKey}`,
      'x-workspace-id': cfg.workspaceId,
      'content-type': 'application/json',
      'user-agent': '@mnemo/mcp-server',
    }
    this.container = cfg.container
    this.fetchImpl = cfg.fetch ?? fetch
    this.timeoutMs = cfg.timeoutMs ?? 30_000
  }

  /**
   * Spreads the configured tenant boundary into a request body.
   * Exactly one of `containerTag` / `scope` is present.
   */
  private containerBody(): Record<string, unknown> {
    return this.container.containerTag !== undefined
      ? { containerTag: this.container.containerTag }
      : { scope: this.container.scope }
  }

  async search(input: { query: string; limit?: number }): Promise<SearchResponse> {
    // SearchRequestDto: field is `q` (NOT `query`); containerTag|scope required.
    return this.request<SearchResponse>('POST', '/v1/search', {
      q: input.query,
      ...this.containerBody(),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
  }

  async addMemory(input: {
    content: string
    metadata?: Record<string, unknown>
  }): Promise<AddResponse> {
    // CreateMemoriesDto: content wrapped in `items[]`; containerTag|scope
    // required at runtime (DTO marks only `items`, but prod 400s without it).
    return this.request<AddResponse>('POST', '/v1/memories', {
      items: [
        {
          content: input.content,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        },
      ],
      ...this.containerBody(),
    })
  }

  async updateMemory(
    memoryId: string,
    input: { content?: string; metadata?: Record<string, unknown> },
  ): Promise<Memory> {
    // UpdateMemoryDto: {content?, memoryType?, metadata?, source?} — all
    // optional. Path is /v1/memories/{memoryId}; header carries the workspace.
    return this.request<Memory>(
      'PATCH',
      `/v1/memories/${encodeURIComponent(memoryId)}`,
      input,
    )
  }

  async deleteMemory(memoryId: string): Promise<{ id: string; deleted: true }> {
    return this.request<{ id: string; deleted: true }>(
      'DELETE',
      `/v1/memories/${encodeURIComponent(memoryId)}`,
    )
  }

  async listMemories(input?: {
    limit?: number
    cursor?: string
  }): Promise<{ items: Memory[]; nextCursor: string | null }> {
    // GET /v1/memories filters by containerTag (or scopeType+scopeId), NOT
    // actorId. Thread the server-configured container as the filter.
    const params = new URLSearchParams()
    if (input?.limit !== undefined) params.set('limit', String(input.limit))
    if (input?.cursor !== undefined) params.set('cursor', input.cursor)
    if (this.container.containerTag !== undefined) {
      params.set('containerTag', this.container.containerTag)
    } else if (this.container.scope) {
      params.set('scopeType', this.container.scope.type)
      params.set('scopeId', this.container.scope.id)
    }
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
