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
 * supplied once at construction from SERVER CONFIG/ENV as the DEFAULT
 * container. For the hosted multi-container model a caller MAY additionally
 * request a specific container per call; that request is sent as the
 * `X-Mnemo-Container` header and is VALIDATED SERVER-SIDE against the
 * connection's allowed set (403 out-of-scope, 400 write-needs-container).
 * The model can only target containers the connection already permits.
 */

/** Header the API reads to target a specific allowed container per call. */
export const CONTAINER_HEADER = 'x-mnemo-container'

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

export type MemorySource = Record<string, unknown>

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
   * DEFAULT tenant boundary, supplied at server startup (env) or from an
   * OAuth grant. Local (stdio/header) mode REQUIRES it — every call is pinned
   * to it unless a validated per-call container overrides. Hosted OAuth mode
   * MAY leave it UNSET for "all containers" or multi-container grants: the API
   * then resolves scope from the grant, and a per-call `X-Mnemo-Container`
   * header targets a specific container. Never a model-set boundary.
   */
  container?: ContainerScope
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
  /**
   * Default tenant boundary, threaded into every request that lacks a
   * per-call override. Undefined only in hosted OAuth mode (all/multi grants),
   * where the API resolves scope from the grant + per-call header.
   */
  private readonly container?: ContainerScope

  constructor(cfg: ApiClientConfig) {
    if (!cfg.apiKey) throw new Error('apiKey is required')
    if (!cfg.workspaceId) throw new Error('workspaceId is required')
    // A default container is optional (hosted OAuth all/multi grants omit it),
    // but if one IS supplied it must be a valid form.
    if (cfg.container && !cfg.container.containerTag && !cfg.container.scope) {
      throw new Error('container, when set, must have a containerTag or scope')
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
   * Spreads the effective tenant boundary into a request body. A per-call
   * `override` container tag (validated server-side) wins over the configured
   * default; otherwise exactly one of `containerTag` / `scope` is present.
   */
  private containerBody(override?: string): Record<string, unknown> {
    if (override !== undefined) return { containerTag: override }
    if (this.container?.containerTag !== undefined) return { containerTag: this.container.containerTag }
    if (this.container?.scope) return { scope: this.container.scope }
    // Unset (hosted all/multi grant): the API resolves scope from the grant.
    return {}
  }

  async search(input: { query: string; limit?: number; container?: string }): Promise<SearchResponse> {
    // SearchRequestDto: field is `q` (NOT `query`); containerTag|scope required.
    return this.request<SearchResponse>(
      'POST',
      '/v1/search',
      {
        q: input.query,
        ...this.containerBody(input.container),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
      input.container,
    )
  }

  async addMemory(input: {
    content: string
    memoryType?: string
    metadata?: Record<string, unknown>
    source?: MemorySource
    idempotencyKey?: string
    container?: string
  }): Promise<AddResponse> {
    // CreateMemoriesDto: content wrapped in `items[]`; containerTag|scope
    // required at runtime (DTO marks only `items`, but prod 400s without it).
    return this.request<AddResponse>(
      'POST',
      '/v1/memories',
      {
        items: [
          {
            content: input.content,
            ...(input.memoryType !== undefined ? { memoryType: input.memoryType } : {}),
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            ...(input.source !== undefined ? { source: input.source } : {}),
            ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
          },
        ],
        ...this.containerBody(input.container),
      },
      input.container,
    )
  }

  async updateMemory(
    memoryId: string,
    input: {
      content?: string
      memoryType?: string
      metadata?: Record<string, unknown> | null
      source?: MemorySource | null
    },
    container?: string,
  ): Promise<Memory> {
    // UpdateMemoryDto: {content?, memoryType?, metadata?, source?} — all
    // optional. Direct access is additionally pinned by the effective scope
    // query so same-workspace containers cannot cross read/write boundaries.
    return this.request<Memory>(
      'PATCH',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      input,
      container,
    )
  }

  async getMemory(memoryId: string, container?: string): Promise<Memory> {
    return this.request<Memory>(
      'GET',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      undefined,
      container,
    )
  }

  async deleteMemory(memoryId: string, container?: string): Promise<{ id: string; deleted: true }> {
    return this.request<{ id: string; deleted: true }>(
      'DELETE',
      `/v1/memories/${encodeURIComponent(memoryId)}${this.containerQuery(container)}`,
      undefined,
      container,
    )
  }

  private containerQuery(override?: string): string {
    const params = new URLSearchParams()
    if (override !== undefined) {
      params.set('containerTag', override)
    } else if (this.container?.containerTag !== undefined) {
      params.set('containerTag', this.container.containerTag)
    } else if (this.container?.scope) {
      params.set('scopeType', this.container.scope.type)
      params.set('scopeId', this.container.scope.id)
    }
    const query = params.toString()
    return query ? `?${query}` : ''
  }

  async listMemories(input?: {
    limit?: number
    cursor?: string
    container?: string
  }): Promise<{ items: Memory[]; nextCursor: string | null }> {
    // GET /v1/memories filters by containerTag (or scopeType+scopeId), NOT
    // actorId. Thread the effective container (per-call override or default).
    const params = new URLSearchParams()
    if (input?.limit !== undefined) params.set('limit', String(input.limit))
    if (input?.cursor !== undefined) params.set('cursor', input.cursor)
    if (input?.container !== undefined) {
      params.set('containerTag', input.container)
    } else if (this.container?.containerTag !== undefined) {
      params.set('containerTag', this.container.containerTag)
    } else if (this.container?.scope) {
      params.set('scopeType', this.container.scope.type)
      params.set('scopeId', this.container.scope.id)
    }
    const qs = params.toString()
    return this.request('GET', `/v1/memories${qs ? `?${qs}` : ''}`, undefined, input?.container)
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    containerHeader?: string,
  ): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      // Per-call container targeting: when present, the API validates this
      // header against the connection's allowed set. When absent, no header
      // is sent and the API falls back to the connection's allowed set.
      const headers =
        containerHeader !== undefined
          ? { ...this.headers, [CONTAINER_HEADER]: containerHeader }
          : { ...this.headers }
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
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
