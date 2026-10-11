import type { AuthType, Provider } from '@earendil-works/pi-ai'

export interface ProviderAuthChoice {
  value: AuthType
  label: string
  description: string
}

/** Build interactive sign-in choices from the provider's actual auth contract. */
export function getProviderAuthChoices(
  provider: Pick<Provider, 'auth'>,
): ProviderAuthChoice[] {
  const choices: ProviderAuthChoice[] = []
  const oauth = provider.auth.oauth
  const apiKey = provider.auth.apiKey

  if (oauth) {
    choices.push({
      value: 'oauth',
      label: oauth.loginLabel ?? (oauth.isSubscription
        ? 'Subscription sign-in (OAuth)'
        : 'OAuth sign-in'),
      description: oauth.name,
    })
  }

  if (apiKey?.login) {
    choices.push({
      value: 'api_key',
      label: 'API key',
      description: apiKey.name,
    })
  }

  return choices
}
