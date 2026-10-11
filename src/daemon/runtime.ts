import type { AssistantMessage, AssistantMessageEvent, Api, AuthType, Context, Model, Models } from '@earendil-works/pi-ai'
import { createModelsForCwd, getAllModels, getConfiguredModel, getModels, loadCustomModels } from '../models/index.ts'
import { getProviderAuthChoices } from '../models/authChoices.ts'
import type { GatewayModelRuntime, GatewayRequestOptions } from './types.ts'

const reasoningSummaryApis = new Set(['openai-responses', 'openai-codex-responses', 'azure-openai-responses'])

function simpleOptions(options: GatewayRequestOptions & { signal?: AbortSignal }) {
  return {
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
    signal: options.signal,
  }
}

export function streamPiModel(models: Models, model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): AsyncIterable<AssistantMessageEvent> {
  if (options.reasoningSummary && reasoningSummaryApis.has(model.api)) {
    return models.stream(model, context, {
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
      reasoningSummary: options.reasoningSummary,
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
      signal: options.signal,
    } as any)
  }
  return models.streamSimple(model, context, simpleOptions(options))
}

export function completePiModel(models: Models, model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): Promise<AssistantMessage> {
  if (options.reasoningSummary && reasoningSummaryApis.has(model.api)) {
    return models.complete(model, context, {
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.reasoning === undefined ? {} : { reasoningEffort: options.reasoning }),
      reasoningSummary: options.reasoningSummary,
      ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
      ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
      signal: options.signal,
    } as any)
  }
  return models.completeSimple(model, context, simpleOptions(options))
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().replace(/^models\//, '')
}

export function resolveGatewayModel(modelId: string, models = getAllModels()): Model<Api> | undefined {
  const requested = normalizeModelId(modelId)
  const slash = requested.indexOf('/')
  if (slash > 0) {
    const provider = requested.slice(0, slash)
    const id = requested.slice(slash + 1)
    return models.find((model) => String(model.provider) === provider && model.id === id)
  }
  const matches = models.filter((model) => model.id === requested)
  return matches.length === 1 ? matches[0] : undefined
}

interface ProjectModelCollection {
  fingerprint: string
  models: Models
  allModels: Model<Api>[]
}

/** Stateful adapter between the gateway runtime contract and Pi model collections. */
export class PiGatewayRuntime implements GatewayModelRuntime {
  private readonly modelCollections = new WeakMap<object, Models>()
  private readonly projectCollections = new Map<string, ProjectModelCollection>()

  private remember(models: Models, entries: readonly Model<Api>[]): void {
    for (const model of entries) this.modelCollections.set(model, models)
  }

  private projectCollection(cwd: string): ProjectModelCollection {
    const fingerprint = JSON.stringify(loadCustomModels(cwd))
    const cached = this.projectCollections.get(cwd)
    if (cached?.fingerprint === fingerprint) {
      this.projectCollections.delete(cwd)
      this.projectCollections.set(cwd, cached)
      return cached
    }
    const scoped = createModelsForCwd(cwd)
    const entry = { fingerprint, ...scoped }
    this.projectCollections.set(cwd, entry)
    while (this.projectCollections.size > 8) this.projectCollections.delete(this.projectCollections.keys().next().value!)
    return entry
  }

  private collectionFor(cwd?: string): Models {
    return cwd ? this.projectCollection(cwd).models : getModels()
  }

  getModels(projectCwd?: string): readonly Model<Api>[] {
    if (projectCwd) {
      const scoped = this.projectCollection(projectCwd)
      this.remember(scoped.models, scoped.allModels)
      return scoped.allModels
    }
    const entries = getAllModels()
    this.remember(getModels(), entries)
    return entries
  }

  getCurrentModel(projectCwd?: string): Model<Api> {
    const scoped = projectCwd ? this.projectCollection(projectCwd) : undefined
    const entries = scoped?.allModels ?? getAllModels()
    const model = getConfiguredModel(entries)
    this.remember(scoped?.models ?? getModels(), [model])
    return model
  }

  getProviders(projectCwd?: string) {
    return this.collectionFor(projectCwd).getProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      authChoices: getProviderAuthChoices(provider),
    }))
  }

  async checkAuth(providerId: string, projectCwd: string | undefined, signal: AbortSignal) {
    const auth = await this.collectionFor(projectCwd).checkAuth(providerId, { signal })
    return auth ? { type: auth.type } : undefined
  }

  async login(providerId: string, type: AuthType, interaction: Parameters<GatewayModelRuntime['login']>[2], projectCwd?: string): Promise<void> {
    await this.collectionFor(projectCwd).login(providerId, type, interaction)
  }

  async logout(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<void> {
    await this.collectionFor(projectCwd).logout(providerId, { signal })
  }

  resolveModel(id: string, projectCwd?: string): Model<Api> | undefined {
    if (projectCwd) {
      const scoped = this.projectCollection(projectCwd)
      const model = resolveGatewayModel(id, scoped.allModels)
      if (model) this.remember(scoped.models, [model])
      return model
    }
    const entries = getAllModels()
    const model = resolveGatewayModel(id, entries)
    if (model) this.remember(getModels(), [model])
    return model
  }

  stream(model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): AsyncIterable<AssistantMessageEvent> {
    const collection = this.modelCollections.get(model) ?? getModels()
    return streamPiModel(collection, model, context, options)
  }

  complete(model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): Promise<AssistantMessage> {
    const collection = this.modelCollections.get(model) ?? getModels()
    return completePiModel(collection, model, context, options)
  }
}

export function createPiGatewayRuntime(): GatewayModelRuntime {
  return new PiGatewayRuntime()
}

export type { AssistantMessage, AssistantMessageEvent, Context, Model }
