import { describe, expect, test } from 'bun:test'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { getProviderAuthChoices } from '../../src/models/authChoices.ts'
import { getModels } from '../../src/models/registry.ts'

describe('provider authentication choices', () => {
  const providers = builtinProviders()

  test('exposes OAuth for every OAuth provider in the pinned Pi catalog', () => {
    const oauthProviders = providers.filter((provider) => provider.auth.oauth)
    const providerIds = oauthProviders.map((provider) => provider.id).sort()

    expect(providerIds).toEqual([
      'anthropic',
      'github-copilot',
      'kimi-coding',
      'meta',
      'openai-codex',
      'openrouter',
      'radius',
      'xai',
    ])

    for (const provider of oauthProviders) {
      const choice = getProviderAuthChoices(provider).find(({ value }) => value === 'oauth')
      expect(choice).toBeDefined()
      expect(choice?.description).toBe(provider.auth.oauth?.name)
      expect(choice?.label).toBe(provider.auth.oauth?.loginLabel ?? (
        provider.auth.oauth?.isSubscription
          ? 'Subscription sign-in (OAuth)'
          : 'OAuth sign-in'
      ))
      expect(typeof provider.auth.oauth?.login).toBe('function')

      const registeredOAuth = getModels().getProvider(provider.id)?.auth.oauth
      expect(typeof registeredOAuth?.login).toBe('function')
      expect(typeof registeredOAuth?.refresh).toBe('function')
      expect(typeof registeredOAuth?.toAuth).toBe('function')
    }
  })

  test('offers API-key login only when the provider supplies a login interaction', () => {
    for (const provider of providers) {
      const apiKeyChoice = getProviderAuthChoices(provider).find(({ value }) => value === 'api_key')

      if (provider.auth.apiKey?.login) {
        expect(apiKeyChoice).toEqual({
          value: 'api_key',
          label: 'API key',
          description: provider.auth.apiKey.name,
        })
      } else {
        expect(apiKeyChoice).toBeUndefined()
      }
    }
  })

  test('does not describe non-subscription OAuth providers as subscription sign-in', () => {
    for (const provider of providers.filter((entry) => entry.auth.oauth && !entry.auth.oauth.isSubscription)) {
      const choice = getProviderAuthChoices(provider).find(({ value }) => value === 'oauth')
      expect(choice?.label).not.toContain('subscription')
      expect(choice?.label).not.toContain('Subscription')
    }
  })
})
