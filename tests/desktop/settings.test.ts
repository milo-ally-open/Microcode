import { describe, expect, test } from 'bun:test'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import { DesktopModelSettings } from '../../src/desktop/settings.ts'

const TEST_SECRET = 'test-secret-value-never-real'

function createSettings(status: unknown) {
  const provider = {
    id: 'sample-provider',
    name: 'Sample Provider',
    auth: { apiKey: { name: 'API key', login: async () => TEST_SECRET } },
  }
  const model = {
    id: 'sample-model',
    provider: provider.id,
    api: 'openai-completions',
    name: 'Sample Model',
    contextWindow: 32_000,
  } as unknown as Model<Api>
  const calls: string[] = []
  const models = {
    getProviders: () => [provider],
    getProvider: (id: string) => id === provider.id ? provider : undefined,
    checkAuth: async () => status,
    login: async (...args: unknown[]) => { calls.push('login'); return { key: TEST_SECRET, args } },
    logout: async () => { calls.push('logout') },
  } as unknown as Models
  return { settings: new DesktopModelSettings(models, () => [model]), calls, model }
}

describe('desktop model settings', () => {
  test('reports missing credentials and blocks selection before a model switch', async () => {
    const { settings, model } = createSettings(undefined)
    const snapshot = await settings.getSnapshot()

    expect(snapshot.providers[0]).toMatchObject({ id: 'sample-provider', configured: false, savedCredential: false })
    expect(snapshot.models[0]).toMatchObject({ id: 'sample-model', authentication: 'missing' })
    await expect(settings.assertModelConfigured(model)).rejects.toThrow('has no configured credentials')
  })

  test('projects only safe auth metadata and supports the existing provider login/logout APIs', async () => {
    const { settings, calls, model } = createSettings({ type: 'api_key', source: 'stored credential', key: TEST_SECRET })
    const snapshot = await settings.getSnapshot()

    expect(snapshot.providers[0]).toMatchObject({ configured: true, authType: 'api_key', source: 'stored credential', savedCredential: true })
    expect(snapshot.models[0]).toMatchObject({ authentication: 'configured', authType: 'api_key', authSource: 'stored credential' })
    expect(JSON.stringify(snapshot)).not.toContain(TEST_SECRET)
    await settings.assertModelConfigured(model)
    await settings.login('sample-provider', 'api_key', { prompt: async () => TEST_SECRET } as never)
    await settings.logout('sample-provider')
    expect(calls).toEqual(['login', 'logout'])
  })

  test('isolates provider auth status failures from model and provider identifiers', async () => {
    const { settings } = createSettings(Promise.reject(new Error(`authorization secret=${TEST_SECRET}`)))
    const snapshot = await settings.getSnapshot()

    expect(snapshot.providers[0]).toMatchObject({ configured: false, statusError: true })
    expect(snapshot.models[0]?.authentication).toBe('error')
    expect(JSON.stringify(snapshot)).not.toContain(TEST_SECRET)
  })
})
