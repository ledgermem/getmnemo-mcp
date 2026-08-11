import { request } from 'node:http'
import { describe, expect, it } from 'vitest'
import { createMcpHttpServer } from './http.js'

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
