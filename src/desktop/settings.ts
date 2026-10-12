import type { Api, AuthInteraction, AuthType, Model, Models } from '@earendil-works/pi-ai'
import { getAllModels, getModels } from '../models/index.ts'
import { getProviderAuthChoices } from '../models/authChoices.ts'
import type { DesktopAuthProvider, DesktopModelOption } from './protocol.ts'

interface ProviderStatus {
  readonly configured: boolean
  readonly authType?: AuthType
  readonly source?: string
  readonly error: boolean
}

/** Read-only desktop projection of the existing Pi provider and credential APIs. */
export class DesktopModelSettings {
  constructor(
    private readonly models: Models = getModels(),
    private readonly catalog: () => readonly Model<Api>[] = getAllModels,
  ) {}

  async listProviders(): Promise<readonly DesktopAuthProvider[]> {
    const providers = this.models.getProviders()
    const statuses = await this.providerStatuses(providers.map((provider) => provider.id))
    return this.providerOptions(providers, statuses)
  }

  async listModels(): Promise<readonly DesktopModelOption[]> {
    const catalog = this.catalog()
    const statuses = await this.providerStatuses([...new Set(catalog.map((model) => String(model.provider)))])
    return this.modelOptions(catalog, statuses)
  }

  async getSnapshot(): Promise<{
    readonly models: readonly DesktopModelOption[]
    readonly providers: readonly DesktopAuthProvider[]
  }> {
    const providers = this.models.getProviders()
    const catalog = this.catalog()
    const ids = [...new Set([...providers.map((provider) => provider.id), ...catalog.map((model) => String(model.provider))])]
    const statuses = await this.providerStatuses(ids)
    return Object.freeze({
      models: this.modelOptions(catalog, statuses),
      providers: this.providerOptions(providers, statuses),
    })
  }

  async login(providerId: string, authType: AuthType, interaction: AuthInteraction): Promise<void> {
    const provider = this.models.getProvider(providerId)
    if (!provider) throw new Error('That provider is not available in this runtime.')
    if (!getProviderAuthChoices(provider).some((choice) => choice.value === authType)) {
      throw new Error('That sign-in method is not supported by this provider.')
    }
    await this.models.login(providerId, authType, interaction)
  }

  async logout(providerId: string): Promise<void> {
    if (!this.models.getProvider(providerId)) throw new Error('That provider is not available in this runtime.')
    await this.models.logout(providerId)
  }

  async assertModelConfigured(model: Pick<DesktopModelOption, 'id' | 'provider' | 'api'>): Promise<void> {
    const candidate = this.catalog().find((entry) =>
      String(entry.id) === model.id
      && String(entry.provider) === model.provider
      && entry.api === model.api,
    )
    if (!candidate) throw new Error('That model is not available in this runtime. Refresh the model list and try again.')
    const provider = this.models.getProvider(model.provider)
    if (!provider) throw new Error(`Provider ${model.provider} is not available in this runtime. Open Settings to review providers.`)
    try {
      const status = await this.models.checkAuth(provider.id)
      if (!status) throw new Error(`Provider ${provider.name} has no configured credentials. Sign in or configure its existing environment settings in Desktop Settings.`)
    } catch (error) {
      if (error instanceof Error && /has no configured credentials/.test(error.message)) throw error
      throw new Error(`Authentication for ${provider.name} could not be checked. Open Desktop Settings to review this provider.`)
    }
  }

  private async providerStatuses(providerIds: readonly string[]): Promise<Map<string, ProviderStatus>> {
    const unique = [...new Set(providerIds)]
    const statuses = await Promise.all(unique.map(async (providerId): Promise<[string, ProviderStatus]> => {
      try {
        const status = await this.models.checkAuth(providerId)
        return [providerId, {
          configured: Boolean(status),
          authType: status?.type,
          source: status?.source,
          error: false,
        }]
      } catch {
        // Provider/credential errors can contain endpoint and authorization details.
        return [providerId, { configured: false, error: true }]
      }
    }))
    return new Map(statuses)
  }

  private modelOptions(catalog: readonly Model<Api>[], statuses: ReadonlyMap<string, ProviderStatus>): readonly DesktopModelOption[] {
    return Object.freeze(catalog.map((model) => {
      const status = statuses.get(String(model.provider)) ?? { configured: false, error: false }
      return Object.freeze({
        id: String(model.id),
        provider: String(model.provider),
        api: model.api,
        name: model.name,
        contextWindow: model.contextWindow,
        authentication: status.error ? 'error' as const : status.configured ? 'configured' as const : 'missing' as const,
        ...(status.authType ? { authType: status.authType } : {}),
        ...(status.source ? { authSource: status.source } : {}),
      })
    }))
  }

  private providerOptions(
    providers: readonly ReturnType<Models['getProviders']>[number][],
    statuses: ReadonlyMap<string, ProviderStatus>,
  ): readonly DesktopAuthProvider[] {
    return Object.freeze(providers.map((provider) => {
      const status = statuses.get(provider.id) ?? { configured: false, error: false }
      const choices = getProviderAuthChoices(provider).map((choice) => Object.freeze({
        type: choice.value,
        label: choice.label,
        description: choice.description,
      }))
      return Object.freeze({
        id: provider.id,
        name: provider.name,
        configured: status.configured,
        ...(status.authType ? { authType: status.authType } : {}),
        ...(status.source ? { source: status.source } : {}),
        savedCredential: status.configured && (status.authType === 'oauth' || status.source === 'stored credential'),
        ...(status.error ? { statusError: true } : {}),
        choices: Object.freeze(choices),
      })
    }))
  }
}
