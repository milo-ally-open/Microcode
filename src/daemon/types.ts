import type { AssistantMessage, AssistantMessageEvent, AuthEvent, AuthPrompt, AuthType, Context, Model, SimpleStreamOptions, Api } from '@earendil-works/pi-ai'

export type GatewayDialect = 'internal' | 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export interface GatewayRequestOptions {
  maxTokens?: number
  temperature?: number
  reasoning?: SimpleStreamOptions['reasoning']
  reasoningSummary?: 'auto' | 'concise' | 'detailed'
  toolChoice?: SimpleStreamOptions['toolChoice']
  parallelToolCalls?: boolean
  samplingParams?: Record<string, unknown>
}

export interface GatewayChatRequest {
  modelId: string
  context: Context
  options: GatewayRequestOptions
  stream: boolean
  anthropicThinkingDisplay?: 'summarized' | 'omitted'
  responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>
}

export interface GatewayModelDescriptor {
  id: string
  name: string
  provider: string
  api: string
  input: string[]
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  cost: Model<Api>['cost']
  thinkingLevelMap?: Model<Api>['thinkingLevelMap']
  samplingParams?: Model<Api>['samplingParams']
  promptCache?: Model<Api>['promptCache']
  inputLimits?: Model<Api>['inputLimits']
  compat?: Model<Api>['compat']
}

export interface GatewayProviderDescriptor {
  id: string
  name: string
  authChoices: Array<{ value: AuthType; label: string; description: string }>
}

export interface GatewayAuthInteraction {
  signal: AbortSignal
  prompt(prompt: AuthPrompt): Promise<string>
  notify(event: AuthEvent): void
}

export interface GatewayModelRuntime {
  getModels(projectCwd?: string): readonly Model<Api>[]
  getCurrentModel?(projectCwd?: string): Model<Api> | undefined
  getProviders(projectCwd?: string): readonly GatewayProviderDescriptor[]
  checkAuth(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<{ type: AuthType } | undefined>
  login(providerId: string, type: AuthType, interaction: GatewayAuthInteraction, projectCwd?: string): Promise<void>
  logout(providerId: string, projectCwd: string | undefined, signal: AbortSignal): Promise<void>
  resolveModel(modelId: string, projectCwd?: string): Model<Api> | undefined | Promise<Model<Api> | undefined>
  stream(model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): AsyncIterable<AssistantMessageEvent>
  complete(model: Model<Api>, context: Context, options: GatewayRequestOptions & { signal?: AbortSignal }): Promise<AssistantMessage>
}

export interface GatewayServerOptions {
  token: string
  rpcToken: string
  runtime: GatewayModelRuntime
  hostname?: string
  port?: number
  maxRequestBytes?: number
  maxInternalRequestBytes?: number
  maxConcurrentRequests?: number
  maxStreamIdleMs?: number
}

export interface GatewayServerHandle {
  hostname: string
  port: number
  stop(): Promise<void> | void
}

export function describeModel(model: Model<Api>): GatewayModelDescriptor {
  return {
    id: `${model.provider}/${model.id}`,
    name: model.name,
    provider: String(model.provider),
    api: model.api,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    cost: { ...model.cost },
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.samplingParams ? { samplingParams: { ...model.samplingParams } } : {}),
    ...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
    ...(model.inputLimits ? { inputLimits: structuredClone(model.inputLimits) } : {}),
    ...(model.compat ? { compat: structuredClone(model.compat) } : {}),
  }
}
