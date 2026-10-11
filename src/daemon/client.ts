import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthEvent,
  type AuthPrompt,
  type AuthType,
  type Api,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import type { GatewayConnection } from './lifecycle.ts'
import { GATEWAY_PROTOCOL_VERSION } from './server.ts'
import type { GatewayModelDescriptor, GatewayProviderDescriptor } from './types.ts'

interface ProjectModelCatalog {
  models: Model<Api>[]
  currentModelId?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function decodeModel(value: unknown): Model<Api> {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' ||
    typeof value.provider !== 'string' || typeof value.api !== 'string' ||
    !Array.isArray(value.input) || !value.input.every((entry) => entry === 'text' || entry === 'image') ||
    typeof value.contextWindow !== 'number' || typeof value.maxTokens !== 'number' ||
    typeof value.reasoning !== 'boolean' || !isRecord(value.cost)) {
    throw new Error('Gateway project model catalog contains an invalid model descriptor.')
  }
  const descriptor = value as unknown as GatewayModelDescriptor
  const providerPrefix = `${descriptor.provider}/`
  if (!descriptor.id.startsWith(providerPrefix) || descriptor.id.length === providerPrefix.length) {
    throw new Error('Gateway project model catalog contains a model ID that does not match its provider.')
  }
  return {
    id: descriptor.id.slice(providerPrefix.length),
    name: descriptor.name,
    provider: descriptor.provider,
    api: descriptor.api,
    // Generation is always performed by the daemon. Never send or retain the
    // upstream URL/headers in the TUI-side model object.
    baseUrl: '',
    reasoning: descriptor.reasoning,
    input: [...descriptor.input],
    cost: { ...descriptor.cost },
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    ...(descriptor.thinkingLevelMap ? { thinkingLevelMap: { ...descriptor.thinkingLevelMap } } : {}),
    ...(descriptor.samplingParams ? { samplingParams: { ...descriptor.samplingParams } } : {}),
    ...(descriptor.promptCache ? { promptCache: { ...descriptor.promptCache } } : {}),
    ...(descriptor.inputLimits ? { inputLimits: structuredClone(descriptor.inputLimits) } : {}),
    ...(descriptor.compat ? { compat: structuredClone(descriptor.compat) } : {}),
  } as Model<Api>
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function failedMessage(model: Model<Api>, text = 'The Model Gateway request failed.') : AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'error',
    errorMessage: text,
    timestamp: Date.now(),
  }
}

class GatewayRpcError extends Error {}

async function gatewayRpcError(response: Response, operation: string): Promise<GatewayRpcError> {
  let detail = ''
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') {
      detail = body.error.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400)
    }
  } catch {
    // Older or incompatible daemons may return a non-JSON error body.
  }
  const suffix = detail ? `: ${detail}` : '.'
  return new GatewayRpcError(`Model Gateway ${operation} request failed (HTTP ${response.status})${suffix}`)
}

function rpcOptions(options?: SimpleStreamOptions): Record<string, unknown> {
  if (!options) return {}
  return {
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.toolChoice === undefined ? {} : { toolChoice: options.toolChoice }),
    ...(options.samplingParams === undefined ? {} : { samplingParams: options.samplingParams }),
  }
}

export class GatewayClient {
  constructor(
  private connection: GatewayConnection,
  private readonly fetchFn: typeof fetch = fetch,
  private readonly projectCwd = process.cwd(),
  ) {}
  private projectCatalog?: ProjectModelCatalog

  get bindHost(): string {
    return this.connection.host
  }

  setConnection(connection: GatewayConnection): void {
    this.connection = connection
  }

  private url(path: string): string {
    return `${this.connection.baseUrl}${path}`
  }

  async handshake(): Promise<{ protocolVersion: number; modelCount: number }> {
    const requestJson = async (path: string, init: RequestInit, label: string): Promise<Record<string, unknown>> => {
      let response: Response
      try {
        response = await this.fetchFn(this.url(path), { ...init, signal: AbortSignal.timeout(2000) })
      } catch {
        throw new Error(`${label} could not reach the Model Gateway.`)
      }
      if (!response.ok) {
        if (label === 'Gateway private RPC handshake' && response.status === 404) {
          throw new Error('Gateway private RPC handshake failed (HTTP 404). The running daemon is outdated; if no other client is using it, stop it with `microcode gateway stop` and retry.')
        }
        throw new Error(`${label} failed (HTTP ${response.status}).`)
      }
      try {
        const body: unknown = await response.json()
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid object')
        return body as Record<string, unknown>
      } catch {
        throw new Error(`${label} returned an invalid response.`)
      }
    }

    const health = await requestJson('/healthz', { method: 'GET' }, 'Gateway health check')
    if (health.status !== 'ok') throw new Error('Gateway health check returned an unexpected status.')
    if (health.protocol_version !== GATEWAY_PROTOCOL_VERSION) {
      throw new Error(`Gateway protocol mismatch (expected ${GATEWAY_PROTOCOL_VERSION}, received ${String(health.protocol_version ?? 'unknown')}).`)
    }

    const models = await requestJson('/v1/models', {
      method: 'GET',
      headers: { authorization: `Bearer ${this.connection.token}` },
    }, 'Gateway model-list check')
    if (!Array.isArray(models.data)) throw new Error('Gateway model-list check returned an invalid model list.')

    const rpc = await requestJson('/internal/v1/handshake', {
      method: 'GET',
      headers: {
        authorization: `Bearer ${this.connection.rpcToken}`,
        'x-microcode-rpc-version': String(GATEWAY_PROTOCOL_VERSION),
      },
    }, 'Gateway private RPC handshake')
    if (rpc.status !== 'ok' || rpc.protocol_version !== GATEWAY_PROTOCOL_VERSION) {
      throw new Error('Gateway private RPC handshake returned an incompatible response.')
    }

    return { protocolVersion: GATEWAY_PROTOCOL_VERSION, modelCount: models.data.length }
  }

  async loadProjectModelCatalog(): Promise<{ models: readonly Model<Api>[]; currentModelId?: string }> {
    let response: Response
    try {
      const query = new URLSearchParams({ cwd: this.projectCwd })
      response = await this.fetchFn(this.url(`/internal/v1/models?${query}`), {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.connection.rpcToken}`,
          'x-microcode-rpc-version': String(GATEWAY_PROTOCOL_VERSION),
        },
        signal: AbortSignal.timeout(3000),
      })
    } catch {
      throw new Error('Gateway project model catalog could not be reached.')
    }
    if (!response.ok) throw new Error(`Gateway project model catalog failed (HTTP ${response.status}).`)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      throw new Error('Gateway project model catalog returned invalid JSON.')
    }
    if (!isRecord(body) || !Array.isArray(body.data) || !(body.current_model_id === null || typeof body.current_model_id === 'string')) {
      throw new Error('Gateway project model catalog returned an invalid response.')
    }
    const models = body.data.map(decodeModel)
    const currentModelId = typeof body.current_model_id === 'string' ? body.current_model_id : undefined
    if (models.length === 0) throw new Error('Gateway project model catalog is empty.')
    if (currentModelId && !models.some((model) => `${model.provider}/${model.id}` === currentModelId)) {
      throw new Error('Gateway project model catalog selected a current model that is not listed.')
    }
    this.projectCatalog = { models, ...(currentModelId ? { currentModelId } : {}) }
    return { models, ...(currentModelId ? { currentModelId } : {}) }
  }

  private internalHeaders(jsonBody = false): HeadersInit {
    return {
      authorization: `Bearer ${this.connection.rpcToken}`,
      'x-microcode-rpc-version': String(GATEWAY_PROTOCOL_VERSION),
      ...(jsonBody ? { 'content-type': 'application/json' } : {}),
    }
  }

  async listProviders(): Promise<GatewayProviderDescriptor[]> {
    const query = new URLSearchParams({ cwd: this.projectCwd })
    const response = await this.fetchFn(this.url(`/internal/v1/providers?${query}`), {
      method: 'GET',
      headers: this.internalHeaders(),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`Gateway provider catalog failed (HTTP ${response.status}).`)
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('Gateway provider catalog returned an invalid response.')
    return body.data.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string' || !Array.isArray(entry.authChoices)) {
        throw new Error('Gateway provider catalog contains an invalid provider descriptor.')
      }
      const authChoices = entry.authChoices.map((choice) => {
        if (!isRecord(choice) || (choice.value !== 'oauth' && choice.value !== 'api_key') || typeof choice.label !== 'string' || typeof choice.description !== 'string') {
          throw new Error('Gateway provider catalog contains an invalid auth choice.')
        }
        return { value: choice.value as AuthType, label: choice.label, description: choice.description }
      })
      return { id: entry.id, name: entry.name, authChoices }
    })
  }

  async getAuthStatus(): Promise<Array<{ providerId: string; configured: boolean; type?: AuthType; error?: boolean }>> {
    const response = await this.fetchFn(this.url('/internal/v1/auth/status'), {
      method: 'POST',
      headers: this.internalHeaders(true),
      body: JSON.stringify({ cwd: this.projectCwd }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`Gateway auth status request failed (HTTP ${response.status}).`)
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.data)) throw new Error('Gateway auth status returned an invalid response.')
    return body.data.map((entry) => {
      if (!isRecord(entry) || typeof entry.provider_id !== 'string' || typeof entry.configured !== 'boolean') {
        throw new Error('Gateway auth status contains an invalid entry.')
      }
      return {
        providerId: entry.provider_id,
        configured: entry.configured,
        ...(entry.type === 'oauth' || entry.type === 'api_key' ? { type: entry.type } : {}),
        ...(entry.error === true ? { error: true } : {}),
      }
    })
  }

  async logout(providerId: string): Promise<void> {
    const response = await this.fetchFn(this.url('/internal/v1/auth/logout'), {
      method: 'POST',
      headers: this.internalHeaders(true),
      body: JSON.stringify({ cwd: this.projectCwd, provider_id: providerId }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error('Provider sign-out failed through the Model Gateway.')
  }

  async login(providerId: string, authType: AuthType, interaction: {
    signal: AbortSignal
    prompt(prompt: AuthPrompt): Promise<string>
    notify(event: AuthEvent): void
  }): Promise<void> {
    const sessionId = globalThis.crypto.randomUUID()
    const response = await this.fetchFn(this.url('/internal/v1/auth/login'), {
      method: 'POST',
      headers: this.internalHeaders(true),
      body: JSON.stringify({ cwd: this.projectCwd, provider_id: providerId, auth_type: authType, session_id: sessionId }),
      signal: interaction.signal,
    })
    if (!response.ok || !response.body) throw new Error('Provider sign-in could not be started through the Model Gateway.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let activePrompt: AbortController | undefined
    let promptTask: Promise<void> | undefined
    const sendPromptResponse = async (promptId: string, value?: string) => {
      const result = await this.fetchFn(this.url('/internal/v1/auth/respond'), {
        method: 'POST',
        headers: this.internalHeaders(true),
        body: JSON.stringify({ session_id: sessionId, prompt_id: promptId, ...(value === undefined ? { cancel: true } : { value }) }),
        signal: interaction.signal,
      })
      if (!result.ok && !(value === undefined && result.status === 404) && !interaction.signal.aborted) throw new Error('The Model Gateway rejected an auth prompt response.')
    }
    const handleFrame = (frame: unknown) => {
      if (!isRecord(frame) || typeof frame.type !== 'string') throw new Error('Model Gateway returned an invalid auth event.')
      if (frame.type === 'notify') {
        if (!isRecord(frame.event) || typeof frame.event.type !== 'string') throw new Error('Model Gateway returned an invalid auth notification.')
        interaction.notify(frame.event as AuthEvent)
      } else if (frame.type === 'prompt') {
        if (typeof frame.prompt_id !== 'string' || !isRecord(frame.prompt) || typeof frame.prompt.type !== 'string') {
          throw new Error('Model Gateway returned an invalid auth prompt.')
        }
        if (promptTask) throw new Error('Model Gateway requested overlapping auth prompts.')
        activePrompt = new AbortController()
        const prompt = { ...frame.prompt, signal: activePrompt.signal } as AuthPrompt
        const controller = activePrompt
        const task = interaction.prompt(prompt)
          .then((value) => sendPromptResponse(frame.prompt_id as string, value))
          .catch(async () => {
            if (!interaction.signal.aborted) await sendPromptResponse(frame.prompt_id as string)
          })
        promptTask = task
        const clearTask = () => {
          if (promptTask === task) promptTask = undefined
          if (activePrompt === controller) activePrompt = undefined
        }
        void task.then(clearTask, clearTask)
      } else if (frame.type === 'prompt_cancelled') {
        activePrompt?.abort(new Error('Provider no longer needs this auth prompt.'))
      } else if (frame.type !== 'done' && frame.type !== 'error') {
        throw new Error('Model Gateway returned an unknown auth event.')
      }
      return frame.type
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const type = handleFrame(JSON.parse(line))
          if (type === 'done') {
            await promptTask
            return
          }
          if (type === 'error') {
            activePrompt?.abort()
            await promptTask?.catch(() => undefined)
            throw new Error('Provider sign-in failed or was cancelled.')
          }
        }
        if (done) {
          if (buffer.trim()) {
            const type = handleFrame(JSON.parse(buffer))
            if (type === 'done') { await promptTask; return }
            if (type === 'error') throw new Error('Provider sign-in failed or was cancelled.')
          }
          break
        }
      }
      throw new Error('Model Gateway auth stream ended before sign-in completed.')
    } catch (error) {
      activePrompt?.abort()
      await reader.cancel().catch(() => undefined)
      if (interaction.signal.aborted) throw new Error('Authentication cancelled.')
      throw error
    }
  }

  getProjectModels(): readonly Model<Api>[] {
    if (!this.projectCatalog) throw new Error('Gateway project model catalog has not been loaded.')
    return this.projectCatalog.models
  }

  resolveProjectModel(modelId: string, api?: Api, provider?: string): { model: Model<Api>; apiKey: string } {
    const models = this.getProjectModels()
    // Fully qualified IDs must be matched as a unit. Model IDs can themselves
    // contain slashes, so treating them as unqualified IDs creates false
    // ambiguities (for example deepseek/... on OpenRouter vs DeepSeek).
    let candidates = modelId.includes('/')
      ? models.filter((model) => `${model.provider}/${model.id}` === modelId)
      : models.filter((model) => model.id === modelId)
    if (candidates.length === 0) candidates = models.filter((model) => model.id.includes(modelId) || modelId.includes(model.id))
    if (api) candidates = candidates.filter((model) => model.api === api)
    if (provider) candidates = candidates.filter((model) => model.provider === provider)
    if (candidates.length === 0) throw new Error(`Model "${modelId}" was not found in the Model Gateway catalog.`)
    if (candidates.length > 1) throw new Error(`Model "${modelId}" is ambiguous in the Model Gateway catalog; specify provider/model.`)
    return { model: candidates[0]!, apiKey: '' }
  }

  getProjectDefaultModelConfig(modelId?: string): { model: Model<Api>; apiKey: string } {
    const catalog = this.projectCatalog
    if (!catalog) throw new Error('Gateway project model catalog has not been loaded.')
    const selectedId = modelId ?? catalog.currentModelId
    if (!selectedId) throw new Error('The Model Gateway did not report a configured current model.')
    return this.resolveProjectModel(selectedId)
  }

  async completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
    const response = await this.fetchFn(this.url('/internal/v1/complete'), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.connection.rpcToken}`, 'content-type': 'application/json', 'x-microcode-rpc-version': String(GATEWAY_PROTOCOL_VERSION) },
      body: JSON.stringify({ model: `${model.provider}/${model.id}`, cwd: this.projectCwd, context, options: rpcOptions(options) }),
      signal: options?.signal,
    })
    if (!response.ok) throw await gatewayRpcError(response, 'completion')
    return await response.json() as AssistantMessage
  }

  streamSimple: StreamFn = (model, context, options) => {
    const stream = createAssistantMessageEventStream()
    void this.pumpStream(model, context, options, stream)
    return stream
  }

  private async pumpStream(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    stream: ReturnType<typeof createAssistantMessageEventStream>,
  ): Promise<void> {
    try {
      const response = await this.fetchFn(this.url('/internal/v1/stream'), {
        method: 'POST',
        headers: { authorization: `Bearer ${this.connection.rpcToken}`, 'content-type': 'application/json', 'x-microcode-rpc-version': String(GATEWAY_PROTOCOL_VERSION) },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, cwd: this.projectCwd, context, options: rpcOptions(options) }),
        signal: options?.signal,
      })
      if (!response.ok) throw await gatewayRpcError(response, 'stream')
      if (!response.body) throw new GatewayRpcError('Model Gateway stream response had no body.')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal = false
      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value, { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line) continue
          const event = JSON.parse(line) as AssistantMessageEvent | { type: 'rpc_error'; message?: string }
          if (event.type === 'rpc_error') {
            stream.push({ type: 'error', reason: 'error', error: failedMessage(model, event.message ?? 'Model Gateway request failed.') })
            terminal = true
            break
          }
          stream.push(event)
          if (event.type === 'done' || event.type === 'error') terminal = true
        }
        if (terminal || done) break
      }
      if (!terminal) stream.push({ type: 'error', reason: 'error', error: failedMessage(model, 'Model Gateway stream ended unexpectedly.') })
    } catch (error) {
      const aborted = options?.signal?.aborted
      const message = error instanceof GatewayRpcError
        ? error.message
        : aborted ? 'Request cancelled.' : 'Model Gateway request failed.'
      stream.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: failedMessage(model, message) })
    }
  }

  asModelsProxy(): Models {
    const self = this
    // This models-shaped adapter is only for Pi generation APIs. The catalog and
    // model resolution use the versioned private RPC methods above; provider auth
    // will use its own RPC surface rather than being inferred from this proxy.
    const proxy = {
      streamSimple(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
        return self.streamSimple(model, context, options)
      },
      completeSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
        return self.completeSimple(model, context, options)
      },
    }
    return proxy as unknown as Models
  }
}

export function createGatewayStreamFn(client: GatewayClient): StreamFn {
  return (model, context, options) => client.streamSimple(model, context, options)
}
