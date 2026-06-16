#!/usr/bin/env node
/**
 * CI prod smoke gate for the `getmnemo-mcp` server.
 *
 * Runs a real round-trip against PRODUCTION using THIS package's OWN built
 * thin api-client in `./dist` (no core getmnemo dependency), then asserts the
 * cross-container tenant-isolation boundary. The publish workflow gates
 * `publish` on `needs: smoke`, so a red run here blocks the release.
 *
 * The MCP api-client pins the tenant boundary (container) at CONSTRUCTION —
 * it is NOT a per-call argument (that is the whole point of the server-side
 * security model). So container A and container B are exercised by building
 * TWO separate clients, each pinned to its own containerTag.
 *
 * Exit codes:
 *   0  happy-path round-trip + BOTH isolation assertions passed.
 *   1  missing env, round-trip failure, or — loudest of all — a tenant
 *      isolation leak (a live-server security finding, NOT a flaky test).
 *
 * A leak is a production tenant-isolation security finding (cross-container
 * leakage), not a client bug. It outranks the launch — fix the server, do not
 * iterate the client around it.
 *
 * Required env:
 *   MNEMO_API_KEY        scoped test key (needs delete scope for cleanup)
 *   MNEMO_WORKSPACE_ID   throwaway test workspace id
 *   MNEMO_TEST_CONTAINER base containerTag, e.g. "ci-smoke"
 * Optional env:
 *   MNEMO_API_URL        base URL (default https://api.mnemohq.com)
 */

import { MnemoApiClient } from '../dist/index.js'

const DEFAULT_BASE_URL = 'https://api.mnemohq.com'
const PROPAGATION_WAIT_MS = 3_000

function fail(msg) {
  console.error(`\n[smoke] FAIL: ${msg}`)
  process.exit(1)
}

/** LOUD failure for a server-side tenant-isolation leak. */
function isolationFailure(detail) {
  const banner = '='.repeat(72)
  console.error(`\n${banner}`)
  console.error('TENANT ISOLATION FAILURE')
  console.error(banner)
  console.error(
    'A search scoped to one container returned a memory written to a DIFFERENT\n' +
      'container. This is a PRODUCTION tenant-isolation security finding\n' +
      '(cross-container leakage), NOT a flaky test and NOT a client bug.\n\n' +
      'This outranks the launch: STOP, fix the server, and do NOT iterate the\n' +
      'client around it. Publish is correctly blocked.',
  )
  console.error(`\nDetail: ${detail}`)
  console.error(`${banner}\n`)
  process.exit(1)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** True if any search hit's content contains `needle`. */
function resultsContain(response, needle) {
  const results = response?.results
  if (!Array.isArray(results)) return false
  return results.some((hit) => typeof hit?.content === 'string' && hit.content.includes(needle))
}

async function main() {
  const apiKey = process.env.MNEMO_API_KEY
  const workspaceId = process.env.MNEMO_WORKSPACE_ID
  const base = process.env.MNEMO_TEST_CONTAINER
  const baseUrl = process.env.MNEMO_API_URL?.trim() || DEFAULT_BASE_URL

  if (!apiKey) fail('MNEMO_API_KEY is not set')
  if (!workspaceId) fail('MNEMO_WORKSPACE_ID is not set')
  if (!base) fail('MNEMO_TEST_CONTAINER is not set')

  // Unique per-run nonce so concurrent / re-run smokes never collide and so a
  // leaked memory from a prior run can't masquerade as this run's data.
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  // containerTag must be "<type>:<id>"; default type "user" when base has no colon.
  const colon = base.indexOf(':')
  const ctype = colon >= 0 ? base.slice(0, colon) : 'user'
  const cidBase = colon >= 0 ? base.slice(colon + 1) : base
  const containerATag = `${ctype}:${cidBase}-a-${nonce}`
  const containerBTag = `${ctype}:${cidBase}-b-${nonce}`
  const alphaContent = `${nonce} codeword ALPHA`
  const bravoContent = `${nonce} codeword BRAVO`

  // The api-client pins the container at construction, so we build one client
  // per container. Same key + workspace; the ONLY difference is the tenant
  // boundary — which is exactly what isolation must enforce.
  const clientA = new MnemoApiClient({
    baseUrl,
    apiKey,
    workspaceId,
    container: { containerTag: containerATag },
  })
  const clientB = new MnemoApiClient({
    baseUrl,
    apiKey,
    workspaceId,
    container: { containerTag: containerBTag },
  })

  console.log('[smoke] base url:    ', baseUrl)
  console.log('[smoke] run nonce:   ', nonce)
  console.log('[smoke] container A: ', containerATag)
  console.log('[smoke] container B: ', containerBTag)

  // Track created ids so cleanup runs even if assertions throw. Pair each id
  // with the client whose container it lives in (delete is also container-pinned).
  const created = []

  try {
    // ---- HAPPY PATH: add to two distinct containers --------------------
    const addA = await clientA.addMemory({ content: alphaContent })
    const addB = await clientB.addMemory({ content: bravoContent })

    for (const item of addA?.items ?? []) if (item?.id) created.push({ id: item.id, client: clientA })
    for (const item of addB?.items ?? []) if (item?.id) created.push({ id: item.id, client: clientB })

    if (created.length < 2) {
      fail(
        `addMemory did not return ids for both writes — got ${created.length} ` +
          `(addA.items=${addA?.items?.length ?? 0}, addB.items=${addB?.items?.length ?? 0})`,
      )
    }

    // Give the indexer a moment to make the writes searchable.
    await sleep(PROPAGATION_WAIT_MS)

    // Round-trip: ALPHA must be retrievable in its OWN container.
    const ownA = await clientA.search({ query: 'codeword ALPHA' })
    if (!resultsContain(ownA, alphaContent)) {
      fail(
        'happy-path round-trip failed: searching container A for "codeword ALPHA" ' +
          'did not return the ALPHA memory in response.results. ' +
          `results=${JSON.stringify(ownA?.results ?? null)}`,
      )
    }
    console.log('[smoke] OK happy-path: addMemory + search round-trip via response.results')

    // ---- ISOLATION ASSERTION (the security gate) -----------------------
    // ALPHA was written to A; a search scoped to B must NOT see it.
    const crossA = await clientB.search({ query: 'codeword ALPHA' })
    if (resultsContain(crossA, alphaContent)) {
      isolationFailure(
        `ALPHA (written to container "${containerATag}") leaked into a search ` +
          `scoped to container "${containerBTag}".`,
      )
    }

    // BRAVO was written to B; a search scoped to A must NOT see it.
    const crossB = await clientA.search({ query: 'codeword BRAVO' })
    if (resultsContain(crossB, bravoContent)) {
      isolationFailure(
        `BRAVO (written to container "${containerBTag}") leaked into a search ` +
          `scoped to container "${containerATag}".`,
      )
    }

    console.log('[smoke] OK isolation: A↛B and B↛A — no cross-container leakage')
  } finally {
    // ---- CLEANUP: best-effort delete; failure warns, never fatal -------
    for (const { id, client } of created) {
      try {
        await client.deleteMemory(id)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[smoke] WARN: cleanup delete failed for memory ${id}: ${msg}`)
      }
    }
  }

  console.log('\n[smoke] PASS: happy-path + both isolation assertions green.')
  process.exit(0)
}

main().catch((err) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
  fail(`unexpected error during smoke run:\n${msg}`)
})
