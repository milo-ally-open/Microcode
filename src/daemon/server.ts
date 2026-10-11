import { randomUUID, timingSafeEqual } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AssistantMessageEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai'
import { describeModel, type GatewayModelRuntime, type GatewayServerHandle, type GatewayServerOptions, type GatewayDialect, type GatewayRequestOptions } from './types.ts'
import { GatewayProtocolError, parseAnthropicRequest, parseOpenAiChatRequest, parseResponsesRequest, serializeAnthropic, serializeOpenAiChat, serializeResponses } from './protocol.ts'
import { protocolEvents, SseFrameEncoder } from './streaming.ts'
import { AsyncQueue } from './asyncQueue.ts'

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024
// Internal TUI RPC may carry the full pre-compaction transcript to the
// summarizer. Keep it bounded, but do not apply the smaller public API limit.
const DEFAULT_MAX_INTERNAL_BODY_BYTES = 32 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90 * 1000
const MAX_AUTH_SESSIONS = 2
export const GATEWAY_PROTOCOL_VERSION = 1
const RPC_VERSION_HEADER = 'x-microcode-rpc-version'

function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  })
}

function errorResponse(status: number, message: string, dialect?: GatewayDialect): Response {
  if (dialect === 'anthropic-messages') return json({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'invalid_request_error', message } }, status)
  if (dialect === 'openai-chat' || dialect === 'openai-responses') return json({ error: { message, type: status === 401 ? 'authentication_error' : 'invalid_request_error', code: status } }, status)
  return json({ error: message }, status)
}

function tokenFromRequest(request: Request): string | undefined {
  const auth = request.headers.get('authorization')
  if (auth) {
    const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (bearer) return bearer[1]
  }
  return request.headers.get('x-api-key') ?? undefined
}

function authenticated(request: Request, expected: string): boolean {
  const supplied = tokenFromRequest(request)
  if (!supplied) return false
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readJson(request: Request, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const contentLength = request.headers.get('content-length')
  if (contentLength && Number(contentLength) > maxBytes) throw new GatewayProtocolError('Request body exceeds the configured size limit.', 413)
  if (!request.body) throw new GatewayProtocolError('Request body is required.')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new GatewayProtocolError('Request body exceeds the configured size limit.', 413)
      }
      chunks.push(value)
    }
  } finally {
    if (signal.aborted) await reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new GatewayProtocolError('Request body must be valid UTF-8 JSON.')
  }
}

function validateDepth(value: unknown, maxDepth = 64): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length) {
    const current = stack.pop()!
    if (current.depth > maxDepth) throw new GatewayProtocolError('Request JSON nesting exceeds the configured limit.')
    if (current.value && typeof current.value === 'object') {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 })
    }
  }
}

function requestSignal(request: Request, controller?: AbortController): AbortSignal {
  return AbortSignal.any([request.signal, ...(controller ? [controller.signal] : []), AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
}

function errorMessage(_error: unknown): string {
  // Upstream errors can contain provider responses, endpoint queries, or auth data.
  // Keep public diagnostics generic rather than risking credential disclosure.
  return 'The model request failed. Check the provider configuration and local logs.'
}

function isGatewayProtocolError(error: unknown): error is GatewayProtocolError {
  return error instanceof GatewayProtocolError
}

async function resolveModel(runtime: GatewayModelRuntime, id: string, projectCwd?: string) {
  const model = await runtime.resolveModel(id, projectCwd)
  if (!model) throw new GatewayProtocolError(`Unknown or ambiguous model: ${id}. Use a provider/model ID from GET /v1/models.`, 404)
  return model
}

async function projectDirectory(value: unknown): Promise<string | undefined> {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !isAbsolute(value)) throw new GatewayProtocolError('Internal project cwd must be an absolute directory path.')
  try {
    const resolved = await realpath(value)
    if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
    return resolved
  } catch {
    throw new GatewayProtocolError('Internal project cwd is not an accessible directory.')
  }
}

function encodeNdjson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value)}\n`)
}

interface PendingAuthPrompt {
  resolve(value: string): void
  reject(error: Error): void
}

interface AuthLoginSession {
  controller: AbortController
  signal: AbortSignal
  queue: AsyncQueue<Record<string, unknown>>
  pending: Map<string, PendingAuthPrompt>
  removeAbortListener(): void
}

function rpcErrorStatus(error: unknown): number {
  return isGatewayProtocolError(error) ? error.status : 400
}

function responseBody<T>(
  iterable: AsyncIterable<T>,
  encode: (value: T) => Uint8Array,
  onFailure: (error: unknown) => Uint8Array | undefined,
  onFinish: () => void,
  onCancel: () => void = () => undefined,
): ReadableStream<Uint8Array> {
  const iterator = iterable[Symbol.asyncIterator]()
  let finished = false
  const finish = () => { if (!finished) { finished = true; onFinish() } }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) { finish(); controller.close(); return }
        controller.enqueue(encode(next.value))
      } catch (error) {
        const safe = onFailure(error)
        if (safe) controller.enqueue(safe)
        finish()
        controller.close()
      }
    },
    async cancel(reason) {
      onCancel()
      try { await iterator.return?.(reason) } catch {}
      finish()
    },
  })
}

async function* withSequenceNumbers<T extends { data: unknown }>(
  items: AsyncIterable<T>,
  sequence: { value: number },
): AsyncGenerator<T> {
  for await (const item of items) {
    if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
      throw new Error('Responses stream emitted a malformed event.')
    }
    yield { ...item, data: { ...(item.data as Record<string, unknown>), sequence_number: sequence.value++ } }
  }
}

async function* terminalEvents(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<AssistantMessageEvent> {
  for await (const event of events) {
    yield event
    if (event.type === 'done' || event.type === 'error') return
  }
  throw new Error('The model stream ended without a terminal event.')
}

async function* enforceSingleToolCall(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<AssistantMessageEvent> {
  let buffering = false
  let toolCallCount = 0
  const buffered: AssistantMessageEvent[] = []
  for await (const event of events) {
    if (!buffering && event.type !== 'toolcall_start') {
      yield event
      if (event.type === 'done' || event.type === 'error') return
      continue
    }
    buffering = true
    if (event.type === 'toolcall_start' && ++toolCallCount > 1) {
      throw new Error('The model returned multiple tool calls while parallel_tool_calls=false.')
    }
    buffered.push(event)
    if (event.type === 'done' || event.type === 'error') {
      yield* buffered
      return
    }
  }
}

async function* abortableEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  signal: AbortSignal,
  idleTimeoutMs?: number,
  controller?: AbortController,
): AsyncGenerator<AssistantMessageEvent> {
  const iterator = events[Symbol.asyncIterator]()
  let complete = false
  try {
    while (true) {
      signal.throwIfAborted()
      let onAbort: (() => void) | undefined
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? new Error('Request cancelled.'))
        signal.addEventListener('abort', onAbort, { once: true })
      })
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const idleTimeout = idleTimeoutMs === undefined
        ? undefined
        : new Promise<never>((_, reject) => {
            idleTimer = setTimeout(() => {
              const error = new DOMException('The model stream exceeded its idle timeout.', 'TimeoutError')
              controller?.abort(error)
              reject(error)
            }, idleTimeoutMs)
          })
      let next: IteratorResult<AssistantMessageEvent>
      try {
        next = await Promise.race(idleTimeout ? [iterator.next(), aborted, idleTimeout] : [iterator.next(), aborted])
      } finally {
        if (idleTimer) clearTimeout(idleTimer)
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
      if (next.done) { complete = true; return }
      yield next.value
      if (next.value.type === 'done' || next.value.type === 'error') { complete = true; return }
    }
  } finally {
    if (!complete) void iterator.return?.()
  }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Request cancelled.'))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('Request cancelled.')) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (result) => { cleanup(); resolve(result) },
      (error) => { cleanup(); reject(error) },
    )
  })
}

function protocolParse(dialect: Exclude<GatewayDialect, 'internal'>, body: unknown) {
  if (dialect === 'openai-chat') return parseOpenAiChatRequest(body)
  if (dialect === 'anthropic-messages') return parseAnthropicRequest(body)
  return parseResponsesRequest(body)
}

function inferDialect(path: string): Exclude<GatewayDialect, 'internal'> | undefined {
  if (path === '/v1/chat/completions') return 'openai-chat'
  if (path === '/v1/messages') return 'anthropic-messages'
  if (path === '/v1/responses') return 'openai-responses'
  return undefined
}

function rpcVersionMatches(request: Request): boolean {
  return request.headers.get(RPC_VERSION_HEADER) === String(GATEWAY_PROTOCOL_VERSION)
}

class GatewayRequestRegistry {
  private activeCount = 0
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly maxConcurrentRequests: number) {}

  acquire(request: Request): { controller: AbortController; signal: AbortSignal; release(): void } | undefined {
    if (this.activeCount >= this.maxConcurrentRequests) return undefined
    this.activeCount++
    const controller = new AbortController()
    this.controllers.add(controller)
    let released = false
    return {
      controller,
      signal: requestSignal(request, controller),
      release: () => {
        if (released) return
        released = true
        this.activeCount--
        this.controllers.delete(controller)
      },
    }
  }

  abortAll(): void {
    for (const controller of this.controllers) controller.abort(new Error('Gateway is stopping.'))
  }
}

class AuthLoginSessionRegistry extends Map<string, AuthLoginSession> {
  abortAll(): void {
    for (const session of this.values()) session.controller.abort(new Error('Gateway is stopping.'))
  }
}

/** Routes gateway requests while owning the active request and auth-session state. */
class GatewayRequestHandler {
  private readonly maxBody: number
  private readonly maxInternalBody: number
  private readonly streamIdleTimeout: number
  private readonly requestRegistry: GatewayRequestRegistry
  private readonly authSessions = new AuthLoginSessionRegistry()

  constructor(
    private readonly options: GatewayServerOptions,
    private readonly stopGateway: () => void,
  ) {
    this.maxBody = options.maxRequestBytes ?? DEFAULT_MAX_BODY_BYTES
    this.maxInternalBody = options.maxInternalRequestBytes ?? DEFAULT_MAX_INTERNAL_BODY_BYTES
    this.streamIdleTimeout = options.maxStreamIdleMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    this.requestRegistry = new GatewayRequestRegistry(options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS)
  }

  stopActiveRequests(): void {
    this.requestRegistry.abortAll()
    this.authSessions.abortAll()
  }

  async handle(request: Request): Promise<Response> {
    const options = this.options
    const { maxBody, maxInternalBody, streamIdleTimeout } = this
    const authSessions = this.authSessions
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return json({ status: 'ok', protocol_version: GATEWAY_PROTOCOL_VERSION, version: process.env.MICROCODE_VERSION ?? 'dev' })
    }
    if (request.method === 'POST' && url.pathname === '/gateway/stop') {
      if (!authenticated(request, options.token)) return errorResponse(401, 'A valid Microcode gateway token is required.')
      queueMicrotask(() => this.stopGateway())
      return json({ status: 'stopping' }, 202)
    }

    const dialect = inferDialect(url.pathname)
    const modelsPath = url.pathname === '/v1/models'
    const handshakePath = url.pathname === '/internal/v1/handshake'
    const tuiModelsPath = url.pathname === '/internal/v1/models'
    const providersPath = url.pathname === '/internal/v1/providers'
    const authStatusPath = url.pathname === '/internal/v1/auth/status'
    const authLoginPath = url.pathname === '/internal/v1/auth/login'
    const authRespondPath = url.pathname === '/internal/v1/auth/respond'
    const authLogoutPath = url.pathname === '/internal/v1/auth/logout'
    const internalGetPath = handshakePath || tuiModelsPath || providersPath
    const internalPostPath = url.pathname === '/internal/v1/stream' || url.pathname === '/internal/v1/complete' || authStatusPath || authLoginPath || authRespondPath || authLogoutPath
    const internalPath = internalGetPath || internalPostPath
    const isModels = request.method === 'GET' && url.pathname === '/v1/models'
    const isTuiModels = request.method === 'GET' && tuiModelsPath
    const isProviders = request.method === 'GET' && providersPath
    const isInternalStream = request.method === 'POST' && url.pathname === '/internal/v1/stream'
    const isInternalComplete = request.method === 'POST' && url.pathname === '/internal/v1/complete'
    const isInternal = url.pathname.startsWith('/internal/')
    if (!dialect && !modelsPath && !internalPath) return errorResponse(404, 'Not found.')
    if ((dialect && request.method !== 'POST') || (modelsPath && request.method !== 'GET') || (internalGetPath && request.method !== 'GET') || (internalPostPath && request.method !== 'POST')) {
      return errorResponse(405, 'Method not allowed.', dialect)
    }
    if (!authenticated(request, isInternal ? options.rpcToken : options.token)) return errorResponse(401, isInternal ? 'A valid Microcode internal RPC token is required.' : 'A valid Microcode gateway token is required.', dialect)
    if (isInternal && !rpcVersionMatches(request)) return errorResponse(426, 'Unsupported internal RPC version.', dialect)
    if (handshakePath) return json({ status: 'ok', protocol_version: GATEWAY_PROTOCOL_VERSION })
    if (isTuiModels) {
      const cwd = await projectDirectory(url.searchParams.get('cwd') ?? undefined)
      const models = options.runtime.getModels(cwd).map(describeModel)
      const currentModel = await options.runtime.getCurrentModel?.(cwd)
      return json({
        data: models,
        current_model_id: currentModel ? `${currentModel.provider}/${currentModel.id}` : null,
      })
    }
    if (isProviders) {
      try {
        const cwd = await projectDirectory(url.searchParams.get('cwd') ?? undefined)
        return json({ data: options.runtime.getProviders(cwd) })
      } catch (error) {
        return errorResponse(rpcErrorStatus(error), error instanceof GatewayProtocolError ? error.message : 'Provider catalog could not be loaded.')
      }
    }
    if (authStatusPath || authLogoutPath || authLoginPath || authRespondPath) {
      const controller = new AbortController()
      const signal = requestSignal(request, controller)
      let value: Record<string, unknown>
      try {
        const body = await readJson(request, maxBody, signal)
        validateDepth(body)
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayProtocolError('Internal auth request must be an object.')
        value = body as Record<string, unknown>
      } catch (error) {
        return errorResponse(rpcErrorStatus(error), error instanceof GatewayProtocolError ? error.message : 'Internal auth request could not be read.')
      }

      if (authRespondPath) {
        const sessionId = value.session_id
        const promptId = value.prompt_id
        if (typeof sessionId !== 'string' || typeof promptId !== 'string') return errorResponse(400, 'Auth response requires a session and prompt ID.')
        const session = authSessions.get(sessionId)
        const pending = session?.pending.get(promptId)
        if (!session || !pending) return errorResponse(404, 'Auth prompt is no longer pending.')
        session.pending.delete(promptId)
        if (value.cancel === true) pending.reject(new Error('Authentication cancelled.'))
        else if (typeof value.value === 'string' && value.value.length <= 16_384) pending.resolve(value.value)
        else return errorResponse(400, 'Auth prompt response must be a string no longer than 16384 characters.')
        return json({ accepted: true })
      }

      let cwd: string | undefined
      if (value.cwd !== undefined) {
        try { cwd = await projectDirectory(value.cwd) } catch (error) {
          return errorResponse(rpcErrorStatus(error), error instanceof GatewayProtocolError ? error.message : 'Internal project cwd is invalid.')
        }
      }

      if (authStatusPath) {
        try {
          const providers = options.runtime.getProviders(cwd)
          const statuses = await Promise.all(providers.map(async (provider) => {
            try {
              const auth = await options.runtime.checkAuth(provider.id, cwd, signal)
              return { provider_id: provider.id, configured: Boolean(auth), type: auth?.type ?? null }
            } catch {
              return { provider_id: provider.id, configured: false, type: null, error: true }
            }
          }))
          return json({ data: statuses })
        } catch {
          return errorResponse(500, 'Provider authentication status could not be read.')
        }
      }

      if (authLogoutPath) {
        if (typeof value.provider_id !== 'string') return errorResponse(400, 'Logout requires a provider ID.')
        try {
          if (!options.runtime.getProviders(cwd).some((provider) => provider.id === value.provider_id)) return errorResponse(404, 'Unknown auth provider.')
          await options.runtime.logout(value.provider_id, cwd, signal)
          return json({ status: 'ok' })
        } catch {
          return errorResponse(400, 'Provider sign-out failed.')
        }
      }

      if (authLoginPath) {
        const providerId = value.provider_id
        const authType = value.auth_type
        const sessionId = value.session_id
        if (typeof providerId !== 'string' || (authType !== 'oauth' && authType !== 'api_key') ||
          typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
          return errorResponse(400, 'Login requires a provider ID, supported auth type, and UUID session ID.')
        }
        if (authSessions.has(sessionId)) return errorResponse(409, 'Auth session ID is already in use.')
        if (authSessions.size >= MAX_AUTH_SESSIONS) return errorResponse(429, 'The gateway is at its interactive auth session limit.')
        let provider
        try { provider = options.runtime.getProviders(cwd).find((entry) => entry.id === providerId) } catch {}
        if (!provider) return errorResponse(404, 'Unknown auth provider.')
        if (!provider.authChoices.some((choice) => choice.value === authType)) return errorResponse(400, 'Provider does not support the requested sign-in method.')

        const queue = new AsyncQueue<Record<string, unknown>>()
        const authController = controller
        const authSignal = signal
        const pending = new Map<string, PendingAuthPrompt>()
        const onAbort = () => {
          for (const prompt of pending.values()) prompt.reject(new Error('Authentication cancelled.'))
          pending.clear()
          queue.close()
        }
        authSignal.addEventListener('abort', onAbort, { once: true })
        authSessions.set(sessionId, {
          controller: authController,
          signal: authSignal,
          queue,
          pending,
          removeAbortListener: () => authSignal.removeEventListener('abort', onAbort),
        })
        let promptSequence = 0
        const login = options.runtime.login(providerId, authType as AuthType, {
          signal: authSignal,
          prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
            if (authSignal.aborted) { reject(authSignal.reason ?? new Error('Authentication cancelled.')); return }
            const promptId = `${sessionId}:${++promptSequence}`
            const cleanup = () => {
              pending.delete(promptId)
              authSignal.removeEventListener('abort', abortPrompt)
              prompt.signal?.removeEventListener('abort', cancelPrompt)
            }
            const resolvePrompt = (value: string) => { cleanup(); resolve(value) }
            const rejectPrompt = (error: Error) => { cleanup(); reject(error) }
            const abortPrompt = () => rejectPrompt(authSignal.reason instanceof Error ? authSignal.reason : new Error('Authentication cancelled.'))
            const cancelPrompt = () => {
              queue.push({ type: 'prompt_cancelled', prompt_id: promptId })
              rejectPrompt(new Error('Auth prompt cancelled by provider.'))
            }
            if (prompt.signal?.aborted) { rejectPrompt(new Error('Auth prompt cancelled by provider.')); return }
            pending.set(promptId, { resolve: resolvePrompt, reject: rejectPrompt })
            const { signal: _promptSignal, ...safePrompt } = prompt
            queue.push({ type: 'prompt', prompt_id: promptId, prompt: safePrompt })
            authSignal.addEventListener('abort', abortPrompt, { once: true })
            prompt.signal?.addEventListener('abort', cancelPrompt, { once: true })
          }),
          notify: (event) => queue.push({ type: 'notify', event }),
        }, cwd)
        void login.then(
          () => queue.push({ type: 'done' }),
          () => queue.push({ type: 'error', message: 'Provider sign-in failed or was cancelled.' }),
        ).finally(() => {
          const session = authSessions.get(sessionId)
          session?.removeAbortListener()
          for (const prompt of pending.values()) prompt.reject(new Error('Authentication flow ended.'))
          pending.clear()
          queue.close()
          authSessions.delete(sessionId)
        })
        return new Response(responseBody(queue, encodeNdjson, () => encodeNdjson({ type: 'error', message: 'Provider sign-in failed.' }), () => undefined, () => authController.abort(new Error('Auth client disconnected.'))), {
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        })
      }
    }
    if (isModels) {
      const data = options.runtime.getModels().map(describeModel)
      return json({ object: 'list', data: data.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: model.provider, name: model.name, api: model.api, context_window: model.contextWindow, max_output_tokens: model.maxTokens, input: model.input, reasoning: model.reasoning })) })
    }
    const lease = this.requestRegistry.acquire(request)
    if (!lease) return errorResponse(429, 'The gateway is at its concurrent request limit.', dialect)
    const { controller, signal, release } = lease

    try {
      const body = await readJson(request, isInternalStream || isInternalComplete ? maxInternalBody : maxBody, signal)
      validateDepth(body)
      if (isInternalStream || isInternalComplete) {
        const value = body as Record<string, unknown>
        if (!value || typeof value.model !== 'string' || !value.context || typeof value.context !== 'object') throw new GatewayProtocolError('Internal request requires model and context.')
        const cwd = await projectDirectory(value.cwd)
        const model = await resolveModel(options.runtime, value.model, cwd)
        const context = value.context as Parameters<GatewayModelRuntime['stream']>[1]
        const rawOptions = value.options && typeof value.options === 'object' ? value.options as Record<string, unknown> : {}
        const safeOptions: GatewayRequestOptions = {
          ...(typeof rawOptions.maxTokens === 'number' ? { maxTokens: rawOptions.maxTokens } : {}),
          ...(typeof rawOptions.temperature === 'number' ? { temperature: rawOptions.temperature } : {}),
          ...(typeof rawOptions.reasoning === 'string' ? { reasoning: rawOptions.reasoning as any } : {}),
          ...(rawOptions.toolChoice === 'auto' || rawOptions.toolChoice === 'none' ? { toolChoice: rawOptions.toolChoice as 'auto' | 'none' } : {}),
          ...(rawOptions.samplingParams && typeof rawOptions.samplingParams === 'object' ? { samplingParams: rawOptions.samplingParams as Record<string, unknown> } : {}),
        }
        if (isInternalComplete) {
          const result = await withAbort(options.runtime.complete(model, context, { ...safeOptions, signal }), signal)
          if (result.stopReason === 'error') throw new Error('Provider generation failed.')
          release()
          return json(result)
        }
        const streamSignal = signal
        const events = abortableEvents(terminalEvents(options.runtime.stream(model, context, { ...safeOptions, signal: streamSignal })), streamSignal, streamIdleTimeout, controller)
        return new Response(responseBody(events, (event) => encodeNdjson(event.type === 'error'
          ? { ...event, error: { ...event.error, errorMessage: 'The model request failed.' } }
          : event), (error) => encodeNdjson({ type: 'rpc_error', message: errorMessage(error) }), release, () => controller.abort()), {
          headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        })
      }

      const parsed = protocolParse(dialect!, body)
      const model = await resolveModel(options.runtime, parsed.modelId)
      if (parsed.options.reasoning && !model.reasoning) throw new GatewayProtocolError('The selected model does not support reasoning controls.')
      if (parsed.options.reasoningSummary) {
        if (!model.reasoning) throw new GatewayProtocolError('The selected model does not support reasoning summaries.')
        if (!['openai-responses', 'openai-codex-responses', 'azure-openai-responses'].includes(model.api)) {
          throw new GatewayProtocolError('The selected model API cannot provide Responses reasoning summaries.')
        }
      }
      if (parsed.options.maxTokens !== undefined && parsed.options.maxTokens > model.maxTokens) {
        throw new GatewayProtocolError(`Requested max output tokens exceed this model's limit (${model.maxTokens}).`)
      }
      if (parsed.stream) {
        const streamSignal = signal
        let generationEvents: AsyncIterable<AssistantMessageEvent> = terminalEvents(options.runtime.stream(model, parsed.context, { ...parsed.options, signal: streamSignal }))
        if (parsed.options.parallelToolCalls === false) generationEvents = enforceSingleToolCall(generationEvents)
        const events = abortableEvents(generationEvents, streamSignal, streamIdleTimeout, controller)
        const iterable = protocolEvents(dialect!, events, model, parsed.anthropicThinkingDisplay, Boolean(parsed.options.reasoningSummary), parsed.responsesToolNamespaces)
        const sequence = { value: 0 }
        const streamItems = dialect === 'openai-responses' ? withSequenceNumbers(iterable, sequence) : iterable
        const frameEncoder = new SseFrameEncoder(dialect!)
        const stream = responseBody(streamItems, (item) => {
          if (item.data === '[DONE]') return new TextEncoder().encode('data: [DONE]\n\n')
          return frameEncoder.encode(item)
        }, (error) => {
          const data = dialect === 'anthropic-messages'
            ? `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: errorMessage(error) } })}\n\n`
            : dialect === 'openai-responses'
              ? `event: response.failed\ndata: ${JSON.stringify({ type: 'response.failed', response: { status: 'failed', error: { message: errorMessage(error) } }, sequence_number: sequence.value++ })}\n\n`
              : `data: ${JSON.stringify({ error: { message: errorMessage(error), type: 'server_error' } })}\n\ndata: [DONE]\n\n`
          return new TextEncoder().encode(data)
        }, release, () => controller.abort())
        return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-content-type-options': 'nosniff' } })
      }
      const message = await withAbort(options.runtime.complete(model, parsed.context, { ...parsed.options, signal }), signal)
      if (message.stopReason === 'error') throw new Error('Provider generation failed.')
      if (parsed.options.parallelToolCalls === false && message.content.filter((block) => block.type === 'toolCall').length > 1) {
        throw new GatewayProtocolError('The model returned multiple tool calls while parallel_tool_calls=false.', 502)
      }
      release()
      const response = dialect === 'openai-chat'
        ? serializeOpenAiChat(message, model)
        : dialect === 'anthropic-messages'
          ? serializeAnthropic(message, model, parsed.anthropicThinkingDisplay)
          : serializeResponses(message, model, Boolean(parsed.options.reasoningSummary), parsed.responsesToolNamespaces)
      return json(response)
    } catch (error) {
      release()
      const timedOut = signal.aborted && (signal.reason as Error | undefined)?.name === 'TimeoutError'
      const status = isGatewayProtocolError(error) ? error.status : timedOut ? 504 : 502
      const message = isGatewayProtocolError(error) ? error.message : timedOut ? 'The model request timed out.' : errorMessage(error)
      return errorResponse(status, message, dialect)
    }
  }
}

/** Owns the HTTP listener and delegates request behavior to its router. */
export class GatewayHttpServer implements GatewayServerHandle {
  private readonly bindHost: string
  private readonly requestedPort: number
  private readonly handler: GatewayRequestHandler
  private readonly server: ReturnType<typeof Bun.serve>

  constructor(options: GatewayServerOptions) {
    this.bindHost = options.hostname ?? '127.0.0.1'
    this.requestedPort = options.port ?? 43127
    this.handler = new GatewayRequestHandler(options, () => this.stop())
    this.server = Bun.serve({
      hostname: this.bindHost,
      port: this.requestedPort,
      fetch: (request) => this.handler.handle(request),
    })
  }

  get hostname(): string {
    return this.server.hostname ?? this.bindHost
  }

  get port(): number {
    return this.server.port ?? this.requestedPort
  }

  stop(): void {
    this.handler.stopActiveRequests()
    this.server.stop(false)
  }
}

export function createGatewayServer(options: GatewayServerOptions): GatewayServerHandle {
  return new GatewayHttpServer(options)
}

export { type GatewayModelRuntime }
