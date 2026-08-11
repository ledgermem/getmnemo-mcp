import { describe, expect, it } from 'vitest'
import { resolveContainerFromEnv, resolveContainerFromHeaders } from './config.js'

describe('container configuration', () => {
  it('requires a complete structured scope', () => {
    expect(resolveContainerFromEnv({ GETMNEMO_SCOPE_TYPE: 'user' })).toBeNull()
    expect(resolveContainerFromEnv({ GETMNEMO_SCOPE_TYPE: 'user', GETMNEMO_SCOPE_ID: 'alice' })).toEqual({
      scope: { type: 'user', id: 'alice' },
    })
  })

  it('resolves a complete per-connection header scope', () => {
    const env = { GETMNEMO_CONTAINER_TAG: 'user:fixed' }
    expect(resolveContainerFromHeaders('user:header', undefined, undefined, env)).toEqual({
      containerTag: 'user:header',
    })
    expect(resolveContainerFromEnv(env)).toEqual({ containerTag: 'user:fixed' })
  })
})
