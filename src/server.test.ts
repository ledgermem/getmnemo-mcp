import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SERVER_VERSION, toolsForPrincipal } from './server.js'

describe('server metadata', () => {
  it('advertises the package version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    expect(SERVER_VERSION).toBe(pkg.version)
    expect(SERVER_VERSION).toBe('0.4.0')
  })
})

describe('toolsForPrincipal', () => {
  it('lists every 0.4.0 core tool for API-key sessions', () => {
    const names = toolsForPrincipal('api_key').map((t) => t.name)
    for (const tool of [
      'memory_search',
      'memory_answer',
      'memory_add',
      'memory_update',
      'memory_get',
      'memory_delete',
      'memory_restore',
      'memory_list',
      'document_add',
      'job_status',
    ]) expect(names, tool).toContain(tool)
  })

  it('hides memory_restore from OAuth sessions (API denies MCP principals on the bare-id route)', () => {
    const names = toolsForPrincipal('oauth').map((t) => t.name)
    expect(names).not.toContain('memory_restore')
    // The rest of the 0.4.0 surface stays visible.
    for (const tool of ['memory_answer', 'document_add', 'job_status']) {
      expect(names, tool).toContain(tool)
    }
  })
})
