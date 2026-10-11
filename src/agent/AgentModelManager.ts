import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { getAllModels, resolveApiKey, type ModelConfig } from '../models/index.ts'

export interface AgentModelSnapshot {
  readonly model: Readonly<Model<Api>>
  readonly provider: string
  readonly apiKeyConfigured: boolean
  readonly thinkingLevel: ThinkingLevel
}

export function resolveAgentModelConfig(modelId: string, api?: Api, provider?: string): ModelConfig {
  const allModels = getAllModels()
  let candidates = allModels.filter((model) => model.id === modelId || `${model.provider}/${model.id}` === modelId)
  if (candidates.length === 0) {
    candidates = allModels.filter(
      (model) => model.id.includes(modelId) || modelId.includes(model.id),
    )
  }
  if (api) {
    candidates = candidates.filter((model) => model.api === api)
  }
  if (provider) candidates = candidates.filter((model) => model.provider === provider)
  if (candidates.length === 0) {
    throw new Error(
      `Model "${modelId}"${api ? ` with API "${api}"` : ''} was not found.`,
    )
  }
  const model = candidates[0]
  return {
    model,
    apiKey: resolveApiKey(model) ?? '',
  }
}

export class AgentModelManager {
  private config: ModelConfig
  private thinkingLevel: ThinkingLevel
  private readonly resolveConfig: (modelId: string, api?: Api, provider?: string) => ModelConfig
  private readonly resolveApiKeyForModel: (model: Model<Api>) => string | undefined

  constructor(options: {
    model: Model<Api>
    apiKey: string
    thinkingLevel?: ThinkingLevel
    resolveModelConfig?: (modelId: string, api?: Api, provider?: string) => ModelConfig
    resolveApiKey?: (model: Model<Api>) => string | undefined
  }) {
    this.config = {
      model: options.model,
      apiKey: options.apiKey,
    }
    this.thinkingLevel = options.thinkingLevel ?? 'off'
    this.resolveConfig = options.resolveModelConfig ?? resolveAgentModelConfig
    this.resolveApiKeyForModel = options.resolveApiKey ?? resolveApiKey
  }

  resolve(modelId: string, api?: Api, provider?: string): ModelConfig {
    return this.resolveConfig(modelId, api, provider)
  }

  commit(config: ModelConfig): void {
    this.config = config
  }

  getModel(): Model<Api> {
    return this.config.model
  }

  getApiKey(): string {
    return this.resolveApiKeyForModel(this.config.model) ?? this.config.apiKey
  }

  getProvider(): string {
    return String(this.config.model.provider)
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level
  }

  getSnapshot(): Readonly<AgentModelSnapshot> {
    return Object.freeze({
      model: Object.freeze({ ...this.config.model }),
      provider: this.getProvider(),
      apiKeyConfigured: this.getApiKey().length > 0,
      thinkingLevel: this.thinkingLevel,
    })
  }
}
