/**
 * Server-config helpers.
 *
 * SECURITY: the tenant boundary (container) is resolved here from
 * developer-supplied env/headers at server startup — it is the ONLY place
 * the container is set, and it is never surfaced as a model-fillable MCP
 * tool argument.
 */

import type { ContainerScope } from './api-client.js'

type EnvLike = Record<string, string | undefined>

/**
 * Resolve the configured tenant boundary from environment variables.
 * Prefers the simple `containerTag` string; falls back to structured scope.
 * Returns `null` when neither form is fully configured.
 */
export function resolveContainerFromEnv(env: EnvLike): ContainerScope | null {
  const tag = env.GETMNEMO_CONTAINER_TAG?.trim()
  if (tag) return { containerTag: tag }

  const scopeType = env.GETMNEMO_SCOPE_TYPE?.trim()
  const scopeId = env.GETMNEMO_SCOPE_ID?.trim()
  if (scopeType && scopeId) return { scope: { type: scopeType, id: scopeId } }

  return null
}

/**
 * Resolve the tenant boundary from a per-connection header bag (HTTP
 * transport), falling back to env. Still developer/operator-supplied at
 * connection time — never a model argument.
 */
export function resolveContainerFromHeaders(
  containerTagHeader: string | undefined,
  scopeTypeHeader: string | undefined,
  scopeIdHeader: string | undefined,
  env: EnvLike,
): ContainerScope | null {
  const tag = containerTagHeader?.trim()
  if (tag) return { containerTag: tag }

  const scopeType = scopeTypeHeader?.trim()
  const scopeId = scopeIdHeader?.trim()
  if (scopeType && scopeId) return { scope: { type: scopeType, id: scopeId } }

  return resolveContainerFromEnv(env)
}
