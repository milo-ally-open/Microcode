import { describe, expect, test } from 'bun:test'
import { configureLoopbackProxyBypass } from '../../src/daemon/proxy.ts'

describe('loopback proxy bypass', () => {
  test('adds loopback hosts to both proxy bypass variables and preserves existing entries', () => {
    const env: Record<string, string | undefined> = {
      NO_PROXY: 'api.example.com,localhost',
      no_proxy: 'internal.example.com',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    }

    configureLoopbackProxyBypass(env)

    expect(env.NO_PROXY).toBe('api.example.com,localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe('internal.example.com,localhost,127.0.0.1,::1')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
  })

  test('is idempotent and avoids duplicate loopback entries regardless of case', () => {
    const env: Record<string, string | undefined> = {
      NO_PROXY: 'LOCALHOST,127.0.0.1,::1',
    }

    configureLoopbackProxyBypass(env)
    configureLoopbackProxyBypass(env)

    expect(env.NO_PROXY).toBe('LOCALHOST,127.0.0.1,::1')
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1')
  })
})
