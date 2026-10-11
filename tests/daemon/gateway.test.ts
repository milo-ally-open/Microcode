import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createConnection } from 'node:net'
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai'
import { getAllModels } from '../../src/models/index.ts'
import { parseResponsesRequest, serializeResponses } from '../../src/daemon/protocol.ts'
import { createGatewayServer } from '../../src/daemon/server.ts'
import { GatewayClient } from '../../src/daemon/client.ts'
import { openAiChatEvents, responsesEvents } from '../../src/daemon/streaming.ts'
import { initializeTuiModelTransport } from '../../src/daemon/startup.ts'
import type { GatewayModelRuntime, GatewayRequestOptions, GatewayServerHandle } from '../../src/daemon/types.ts'
import { configureLoopbackProxyBypass } from '../../src/daemon/proxy.ts'

configureLoopbackProxyBypass()

const TOKEN = 'gateway-test-token'
const RPC_TOKEN = 'gateway-private-rpc-token'
const model = getAllModels().find((item) => item.provider === 'deepseek' && item.id === 'deepseek-v4-pro')!

function assistantMessage(text = 'gateway reply'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    responseId: 'provider-response-id',
  }
}

function messageEvents(message = assistantMessage()): AssistantMessageEvent[] {
  return [
    { type: 'start', partial: message },
    { type: 'text_start', contentIndex: 0, partial: message },
    { type: 'text_delta', contentIndex: 0, delta: 'gateway ' },
    { type: 'text_delta', contentIndex: 0, delta: 'reply' },
    { type: 'text_end', contentIndex: 0, content: 'gateway reply', partial: message },
    { type: 'done', reason: 'stop', message },
  ] as AssistantMessageEvent[]
}

function createRuntime(overrides: Partial<GatewayModelRuntime> = {}) {
  const calls: Array<{ model: Model<any>; context: Context; options: GatewayRequestOptions & { signal?: AbortSignal } }> = []
  const runtime: GatewayModelRuntime = {
    getModels: () => [model],
    getCurrentModel: () => model,
    getProviders: () => [],
    checkAuth: async () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    resolveModel: (id) => id === `${model.provider}/${model.id}` || id === model.id ? model : undefined,
    async *stream(selectedModel, context, options) {
      calls.push({ model: selectedModel, context, options })
      for (const event of messageEvents()) {
        options.signal?.throwIfAborted()
        yield event
      }
    },
    async complete(selectedModel, context, options) {
      calls.push({ model: selectedModel, context, options })
      options.signal?.throwIfAborted()
      return assistantMessage()
    },
    ...overrides,
  }
  return { runtime, calls }
}

describe('Model Gateway HTTP and protocol contracts', () => {
  let handle: GatewayServerHandle
  let baseUrl: string
  let runtimeState: ReturnType<typeof createRuntime>

  beforeEach(() => {
    runtimeState = createRuntime()
    handle = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: runtimeState.runtime, port: 0 })
    baseUrl = `http://${handle.hostname}:${handle.port}`
  })

  afterEach(async () => {
    await handle?.stop()
  })

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  test('serves a minimal unauthenticated health endpoint and protects model discovery', async () => {
    const health = await fetch(`${baseUrl}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok', protocol_version: 1, version: 'dev' })

    const unauthorized = await fetch(`${baseUrl}/v1/models`)
    expect(unauthorized.status).toBe(401)
    expect(runtimeState.calls).toHaveLength(0)

    const listed = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(listed.status).toBe(200)
    const body = await listed.json() as { data: Array<Record<string, unknown>> }
    expect(body.data[0]).toMatchObject({ id: `${model.provider}/${model.id}`, object: 'model', owned_by: model.provider })
    expect(JSON.stringify(body)).not.toContain('apiKey')
    expect(JSON.stringify(body)).not.toContain('baseUrl')
  })

  test('accepts a wildcard IPv4 bind while the local client connects through loopback', async () => {
    const wildcard = createGatewayServer({
      token: TOKEN,
      rpcToken: RPC_TOKEN,
      runtime: runtimeState.runtime,
      hostname: '0.0.0.0',
      port: 0,
    })
    try {
      expect(wildcard.hostname).toBe('0.0.0.0')
      const health = await fetch(`http://127.0.0.1:${wildcard.port}/healthz`)
      expect(health.status).toBe(200)
    } finally {
      await wildcard.stop()
    }
  })

  test('routes authenticated Chat Completions requests and returns tool declarations without executing them', async () => {
    const response = await post('/v1/chat/completions', {
      model: `${model.provider}/${model.id}`,
      messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'hello' }],
      max_tokens: 48,
      tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup data', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body.object).toBe('chat.completion')
    expect(body.id).not.toContain('provider-response-id')
    expect(body.choices[0].message.content).toBe('gateway reply')
    expect(body.usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 })
    expect(runtimeState.calls[0]?.context.messages.map((entry) => entry.role)).toEqual(['system', 'user'])
    expect(runtimeState.calls[0]?.context.tools?.[0]?.name).toBe('lookup')
    expect(runtimeState.calls[0]?.options.maxTokens).toBe(48)
  })

  test('accepts Anthropic x-api-key auth and serializes the Messages response shape', async () => {
    const response = await post('/v1/messages', {
      model: `${model.provider}/${model.id}`,
      max_tokens: 80,
      system: 'Be concise.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }, { 'x-api-key': TOKEN, 'anthropic-version': '2023-06-01' })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({ type: 'message', role: 'assistant', model: `${model.provider}/${model.id}`, stop_reason: 'end_turn' })
    expect(body.id).not.toBe('provider-response-id')
    expect(body.content).toEqual([{ type: 'text', text: 'gateway reply' }])
    expect(runtimeState.calls[0]?.context.messages.map((entry) => entry.role)).toEqual(['system', 'user'])
  })

  test('Anthropic adaptive thinking display never leaks hidden text and preserves its signature', async () => {
    const privateThinking = 'private reasoning text'
    const thinkingMessage = {
      ...assistantMessage(),
      content: [
        { type: 'thinking', thinking: privateThinking, thinkingSignature: 'opaque-signature' },
        { type: 'text', text: 'final answer' },
      ],
    } as AssistantMessage
    const thinkingRuntime = createRuntime({
      async *stream() {
        yield { type: 'start', partial: thinkingMessage }
        yield { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage }
        yield { type: 'thinking_delta', contentIndex: 0, delta: privateThinking, partial: thinkingMessage }
        yield { type: 'thinking_end', contentIndex: 0, content: privateThinking, partial: thinkingMessage }
        yield { type: 'text_start', contentIndex: 1, partial: thinkingMessage }
        yield { type: 'text_delta', contentIndex: 1, delta: 'final answer', partial: thinkingMessage }
        yield { type: 'text_end', contentIndex: 1, content: 'final answer', partial: thinkingMessage }
        yield { type: 'done', reason: 'stop', message: thinkingMessage }
      },
      async complete() { return thinkingMessage },
    })
    const thinkingServer = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: thinkingRuntime.runtime, port: 0 })
    try {
      const request = {
        model: `${model.provider}/${model.id}`,
        max_tokens: 100,
        thinking: { type: 'adaptive', display: 'omitted' },
        messages: [{ role: 'user', content: 'solve this' }],
      }
      const stream = await fetch(`http://${thinkingServer.hostname}:${thinkingServer.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, stream: true }),
      })
      const streamText = await stream.text()
      expect(stream.status).toBe(200)
      expect(streamText).not.toContain(privateThinking)
      expect(streamText).toContain('"type":"signature_delta","signature":"opaque-signature"')
      expect(streamText).toContain('final answer')

      const complete = await fetch(`http://${thinkingServer.hostname}:${thinkingServer.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })
      const completeBody = await complete.json() as any
      expect(JSON.stringify(completeBody)).not.toContain(privateThinking)
      expect(completeBody.content).toContainEqual({ type: 'thinking', thinking: '', signature: 'opaque-signature' })
      expect(completeBody.content).toContainEqual({ type: 'text', text: 'final answer' })

      const unsupportedDisplay = await fetch(`http://${thinkingServer.hostname}:${thinkingServer.port}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, thinking: { type: 'adaptive', display: 'updates' } }),
      })
      expect(unsupportedDisplay.status).toBe(400)
      expect((await unsupportedDisplay.json() as any).error.message).toContain('thinking.display')
    } finally {
      await thinkingServer.stop()
    }
  })

  test('Chat Completions does not leak normalized thinking through a non-standard reasoning_content field', async () => {
    const privateThinking = 'internal reasoning that is not a Chat Completions response field'
    const message = {
      ...assistantMessage('public answer'),
      content: [{ type: 'thinking', thinking: privateThinking }, { type: 'text', text: 'public answer' }],
    } as AssistantMessage
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'thinking_start', contentIndex: 0, partial: message },
      { type: 'thinking_delta', contentIndex: 0, delta: privateThinking, partial: message },
      { type: 'thinking_end', contentIndex: 0, content: privateThinking, partial: message },
      { type: 'text_start', contentIndex: 1, partial: message },
      { type: 'text_delta', contentIndex: 1, delta: 'public answer', partial: message },
      { type: 'text_end', contentIndex: 1, content: 'public answer', partial: message },
      { type: 'done', reason: 'stop', message },
    ]
    const frames = []
    for await (const frame of openAiChatEvents(events, model)) frames.push(frame)

    expect(JSON.stringify(frames)).not.toContain(privateThinking)
    expect(JSON.stringify(frames)).not.toContain('reasoning_content')
    expect(JSON.stringify(frames)).toContain('public answer')
  })

  test('accepts Responses input and returns a Responses-shaped result', async () => {
    const response = await post('/v1/responses', {
      model: `${model.provider}/${model.id}`,
      instructions: 'Be concise.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({ object: 'response', status: 'completed', output_text: 'gateway reply' })
    expect(body.id).not.toBe('provider-response-id')
    expect(body.output[0].content[0]).toMatchObject({ type: 'output_text', text: 'gateway reply' })
  })

  test('Responses reasoning summaries are opt-in and only accepted for summary-capable upstream APIs', async () => {
    const summaryText = 'A concise, user-facing reasoning summary.'
    const thinkingMessage = {
      ...assistantMessage('final answer'),
      content: [{ type: 'thinking', thinking: summaryText }, { type: 'text', text: 'final answer' }],
    } as AssistantMessage

    const defaultOutput = serializeResponses(thinkingMessage, model)
    expect(JSON.stringify(defaultOutput)).not.toContain(summaryText)
    expect(defaultOutput.output).toHaveLength(1)

    const summaryModel = { ...model, api: 'openai-responses' } as Model<any>
    let capturedSummary: string | undefined
    const summaryRuntime = createRuntime({
      resolveModel: () => summaryModel,
      async complete(_selectedModel, _context, options) {
        capturedSummary = options.reasoningSummary
        return thinkingMessage
      },
    })
    const summaryServer = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: summaryRuntime.runtime, port: 0 })
    try {
      const url = `http://${summaryServer.hostname}:${summaryServer.port}/v1/responses`
      const request = (reasoning?: unknown) => fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, input: 'hello', ...(reasoning ? { reasoning } : {}) }),
      })
      const defaultResponse = await request()
      expect(defaultResponse.status).toBe(200)
      expect(JSON.stringify(await defaultResponse.json())).not.toContain(summaryText)

      const optedIn = await request({ effort: 'low', summary: 'auto' })
      expect(optedIn.status).toBe(200)
      expect(capturedSummary).toBe('auto')
      const optedInBody = await optedIn.json() as any
      expect(optedInBody.output[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: summaryText }] })
      expect(optedInBody.output[1].content[0].text).toBe('final answer')

      capturedSummary = undefined
      const optedOut = await request({ effort: 'low', summary: 'none' })
      expect(optedOut.status).toBe(200)
      expect(capturedSummary).toBeUndefined()
      expect(JSON.stringify(await optedOut.json())).not.toContain(summaryText)

      const unsupported = await post('/v1/responses', {
        model: `${model.provider}/${model.id}`, input: 'hello', reasoning: { summary: 'auto' },
      }, { authorization: `Bearer ${TOKEN}` })
      expect(unsupported.status).toBe(400)
      expect((await unsupported.json() as any).error.message).toContain('cannot provide Responses reasoning summaries')
      expect(runtimeState.calls).toHaveLength(0)
    } finally {
      await summaryServer.stop()
    }
  })

  test('Responses streams requested reasoning summaries with stable output item IDs', async () => {
    const summary = 'A safe summary.'
    const thinkingMessage = {
      ...assistantMessage('answer'),
      content: [{ type: 'thinking', thinking: summary }, { type: 'text', text: 'answer' }],
    } as AssistantMessage
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: thinkingMessage },
      { type: 'thinking_start', contentIndex: 0, partial: thinkingMessage },
      { type: 'thinking_delta', contentIndex: 0, delta: summary, partial: thinkingMessage },
      { type: 'thinking_end', contentIndex: 0, content: summary, partial: thinkingMessage },
      { type: 'text_start', contentIndex: 1, partial: thinkingMessage },
      { type: 'text_delta', contentIndex: 1, delta: 'answer', partial: thinkingMessage },
      { type: 'text_end', contentIndex: 1, content: 'answer', partial: thinkingMessage },
      { type: 'done', reason: 'stop', message: thinkingMessage },
    ]
    const frames = []
    for await (const frame of responsesEvents(events, model, true)) frames.push(structuredClone(frame))
    const added = frames.find((frame) => frame.event === 'response.output_item.added' && (frame.data as any).item.type === 'reasoning')?.data as any
    const delta = frames.find((frame) => frame.event === 'response.reasoning_summary_text.delta')?.data as any
    const completed = frames.find((frame) => frame.event === 'response.completed')?.data as any

    expect(added.item.status).toBe('in_progress')
    expect(delta.item_id).toBe(added.item.id)
    expect(delta.delta).toBe(summary)
    expect(completed.response.output[0].id).toBe(added.item.id)
    expect(completed.response.output[0].summary[0].text).toBe(summary)

    const defaultFrames = []
    for await (const frame of responsesEvents(events, model)) defaultFrames.push(structuredClone(frame))
    expect(defaultFrames.some((frame) => frame.event?.startsWith('response.reasoning_'))).toBe(false)
    expect(JSON.stringify(defaultFrames)).not.toContain(summary)
  })

  test('Responses function call item IDs differ from call IDs and round-trip tool results by call_id', async () => {
    const callId = 'call_pi-runtime-id'
    const call = { type: 'toolCall', id: callId, name: 'lookup', arguments: { key: 'value' } } as const
    const message = { ...assistantMessage(), content: [call], stopReason: 'toolUse' } as AssistantMessage
    const response = serializeResponses(message, model)
    const item = response.output[0] as Record<string, unknown>

    expect(item).toMatchObject({ type: 'function_call', call_id: callId, name: 'lookup', status: 'completed' })
    expect(item.id).toBeString()
    expect(item.id).not.toBe(item.call_id)

    const nextRequest = parseResponsesRequest({
      model: `${model.provider}/${model.id}`,
      input: [item, { type: 'function_call_output', call_id: callId, output: 'result' }],
    })
    expect(nextRequest.context.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', id: callId, name: 'lookup' }] })
    expect(nextRequest.context.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: callId, toolName: 'lookup' })
  })

  test('Responses namespace tools and Codex client metadata round-trip without losing namespace identity', async () => {
    const parsed = parseResponsesRequest({
      model: `${model.provider}/${model.id}`,
      input: [
        { type: 'function_call', id: 'fc_item', call_id: 'call_ns', namespace: 'multi_agent_v1', name: 'spawn_agent', arguments: '{"task":"check"}' },
        { type: 'function_call_output', call_id: 'call_ns', output: 'done' },
      ],
      tools: [{
        type: 'namespace', name: 'multi_agent_v1', description: 'Client-owned tools',
        tools: [{ type: 'function', name: 'spawn_agent', strict: true, description: 'Start a task', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false } }],
      }, { type: 'web_search', external_web_access: false }],
      parallel_tool_calls: true,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'codex-test-affinity',
      client_metadata: { originator: 'codex-cli' },
      store: false,
    })

    expect(parsed.context.tools?.map((tool) => tool.name)).toEqual(['multi_agent_v1__spawn_agent'])
    expect(parsed.responsesToolNamespaces?.get('multi_agent_v1__spawn_agent')).toEqual({ namespace: 'multi_agent_v1', name: 'spawn_agent' })
    expect(parsed.context.messages[0]).toMatchObject({ role: 'assistant', content: [{ type: 'toolCall', id: 'call_ns', name: 'multi_agent_v1__spawn_agent' }] })
    expect(parsed.context.messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call_ns', toolName: 'multi_agent_v1__spawn_agent' })

    const toolMessage = { ...assistantMessage(), content: [{ type: 'toolCall', id: 'call_out', name: 'multi_agent_v1__spawn_agent', arguments: { task: 'check' } }], stopReason: 'toolUse' } as AssistantMessage
    expect(serializeResponses(toolMessage, model, false, parsed.responsesToolNamespaces).output[0]).toMatchObject({
      type: 'function_call', call_id: 'call_out', namespace: 'multi_agent_v1', name: 'spawn_agent',
    })
  })

  test('parses Codex Responses Lite additional_tools and its explicit non-parallel defaults', () => {
    const parsed = parseResponsesRequest({
      model: `${model.provider}/${model.id}`,
      input: [
        {
          type: 'additional_tools', role: 'developer', tools: [{
            type: 'namespace', name: 'functions', description: 'Client tools',
            tools: [{ type: 'function', name: 'exec_command', strict: true, parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'], additionalProperties: false } }],
          }],
        },
        { type: 'message', role: 'developer', content: 'Developer instructions.' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning: { effort: 'high', context: 'auto' },
      text: { verbosity: 'low' },
      include: ['reasoning.encrypted_content'],
      client_metadata: { originator: 'codex-cli' },
      prompt_cache_key: 'session-affinity',
      store: false,
    })

    expect(parsed.context.tools?.map((tool) => tool.name)).toEqual(['functions__exec_command'])
    expect(parsed.options).toMatchObject({ toolChoice: 'auto', parallelToolCalls: false, reasoning: 'high' })
    expect(parsed.context.messages).toHaveLength(2)
    expect(parsed.context.messages[0]).toMatchObject({ role: 'system', content: 'Developer instructions.' })
  })

  test('Responses streaming function-call item references use item_id while call_id remains stable', async () => {
    const call = { type: 'toolCall', id: 'call_stream-id', name: 'lookup', arguments: { key: 'value' } } as const
    const message = { ...assistantMessage(), content: [call], stopReason: 'toolUse' } as AssistantMessage
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'toolcall_start', contentIndex: 0, partial: message },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"key":"value"}', partial: message },
      { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]
    const frames = []
    for await (const frame of responsesEvents(events, model)) frames.push(frame)
    const added = frames.find((frame) => frame.event === 'response.output_item.added')?.data as { item: Record<string, unknown> }
    const delta = frames.find((frame) => frame.event === 'response.function_call_arguments.delta')?.data as Record<string, unknown>

    expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_stream-id', name: 'lookup' })
    expect(added.item.id).not.toBe(added.item.call_id)
    expect(delta.item_id).toBe(added.item.id)
  })

  test('Responses streaming keeps namespaced function-call identity', async () => {
    const call = { type: 'toolCall', id: 'call_ns_stream', name: 'multi_agent_v1__spawn_agent', arguments: { task: 'check' } } as const
    const message = { ...assistantMessage(), content: [call], stopReason: 'toolUse' } as AssistantMessage
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: message },
      { type: 'toolcall_start', contentIndex: 0, partial: message },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"task":"check"}', partial: message },
      { type: 'toolcall_end', contentIndex: 0, toolCall: call, partial: message },
      { type: 'done', reason: 'toolUse', message },
    ]
    const namespaces = new Map([['multi_agent_v1__spawn_agent', { namespace: 'multi_agent_v1', name: 'spawn_agent' }]])
    const frames = []
    for await (const frame of responsesEvents(events, model, false, namespaces)) frames.push(frame)
    const added = frames.find((frame) => frame.event === 'response.output_item.added')?.data as { item: Record<string, unknown> }
    const completed = frames.find((frame) => frame.event === 'response.completed')?.data as { response: { output: Record<string, unknown>[] } }
    expect(added.item).toMatchObject({ type: 'function_call', call_id: 'call_ns_stream', namespace: 'multi_agent_v1', name: 'spawn_agent' })
    expect(completed.response.output[0]).toMatchObject({ namespace: 'multi_agent_v1', name: 'spawn_agent' })
  })

  test('does not expose multiple calls when a Responses client disables parallel tool calls', async () => {
    const first = { type: 'toolCall', id: 'call_parallel_one', name: 'first_tool', arguments: {} } as const
    const second = { type: 'toolCall', id: 'call_parallel_two', name: 'second_tool', arguments: {} } as const
    const partial = { ...assistantMessage(), content: [first, second], stopReason: 'toolUse' } as AssistantMessage
    const nonParallel = createRuntime({
      async *stream(_selected, _context, options) {
        options.signal?.throwIfAborted()
        yield { type: 'start', partial } as AssistantMessageEvent
        yield { type: 'toolcall_start', contentIndex: 0, partial } as AssistantMessageEvent
        yield { type: 'toolcall_end', contentIndex: 0, toolCall: first, partial } as AssistantMessageEvent
        yield { type: 'toolcall_start', contentIndex: 1, partial } as AssistantMessageEvent
        yield { type: 'toolcall_end', contentIndex: 1, toolCall: second, partial } as AssistantMessageEvent
        yield { type: 'done', reason: 'toolUse', message: partial } as AssistantMessageEvent
      },
    })
    const limited = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: nonParallel.runtime, port: 0 })
    try {
      const response = await fetch(`http://${limited.hostname}:${limited.port}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: `${model.provider}/${model.id}`, input: 'hello', stream: true, parallel_tool_calls: false,
          tools: [
            { type: 'function', name: 'first_tool', parameters: { type: 'object' } },
            { type: 'function', name: 'second_tool', parameters: { type: 'object' } },
          ],
        }),
      })
      const text = await response.text()
      expect(response.status).toBe(200)
      expect(text).toContain('event: response.failed')
      expect(text).not.toContain('call_parallel_one')
      expect(text).not.toContain('call_parallel_two')
    } finally {
      await limited.stop()
    }
  })

  test('maps failed Pi completion results to a safe upstream error instead of a successful empty response', async () => {
    const failedRuntime = createRuntime({
      async complete() {
        return { ...assistantMessage(), content: [], stopReason: 'error', errorMessage: 'secret provider credential detail' }
      },
    })
    const failedServer = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: failedRuntime.runtime, port: 0 })
    try {
      const response = await fetch(`http://${failedServer.hostname}:${failedServer.port}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, input: 'hello' }),
      })
      expect(response.status).toBe(502)
      expect(await response.text()).not.toContain('secret provider credential detail')
    } finally {
      await failedServer.stop()
    }
  })

  test.each([
    ['/v1/chat/completions', { model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }] }, { authorization: `Bearer ${TOKEN}` }, 'chat.completion.chunk'],
    ['/v1/messages', { model: `${model.provider}/${model.id}`, max_tokens: 40, messages: [{ role: 'user', content: 'hello' }] }, { 'x-api-key': TOKEN }, 'content_block_delta'],
    ['/v1/responses', { model: `${model.provider}/${model.id}`, input: 'hello' }, { authorization: `Bearer ${TOKEN}` }, 'response.output_text.delta'],
  ] as const)('streams the expected SSE dialect at %s', async (path, body, headers, marker) => {
    const response = await post(path, { ...body, stream: true }, headers)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    expect(text).toContain(marker)
    expect(text).not.toContain('provider-response-id')
    if (path === '/v1/chat/completions') expect(text).toContain('data: [DONE]')
    if (path === '/v1/messages') expect(text).toContain('event: message_stop')
    if (path === '/v1/responses') {
      expect(text).toContain('event: response.completed')
      const sequenceNumbers = text.split(/\r?\n\r?\n/).flatMap((frame) => {
        const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith('data: '))
        if (!dataLine) return []
        return [(JSON.parse(dataLine.slice(6)) as { sequence_number?: number }).sequence_number]
      })
      expect(sequenceNumbers.every((sequence, index) => sequence === index)).toBe(true)
    }
  })

  test('uses authenticated, versioned internal RPC for both complete and stream', async () => {
    const headers = { authorization: `Bearer ${RPC_TOKEN}`, 'x-microcode-rpc-version': '1' }
    const complete = await post('/internal/v1/complete', {
      model: `${model.provider}/${model.id}`,
      context: { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    }, headers)
    expect(complete.status).toBe(200)
    expect((await complete.json() as AssistantMessage).content[0]).toMatchObject({ type: 'text', text: 'gateway reply' })

    const stream = await post('/internal/v1/stream', {
      model: `${model.provider}/${model.id}`,
      context: { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    }, headers)
    expect(stream.status).toBe(200)
    const lines = (await stream.text()).trim().split('\n').map((line) => JSON.parse(line))
    expect(lines.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
  })

  test('serves project-scoped model metadata through authenticated private RPC without upstream endpoints', async () => {
    const response = await fetch(`${baseUrl}/internal/v1/models?cwd=${encodeURIComponent(process.cwd())}`, {
      headers: { authorization: `Bearer ${RPC_TOKEN}`, 'x-microcode-rpc-version': '1' },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { data: Array<Record<string, unknown>>; current_model_id: string }
    expect(body.data[0]).toMatchObject({
      id: `${model.provider}/${model.id}`,
      provider: model.provider,
      api: model.api,
    })
    expect(body.current_model_id).toBe(`${model.provider}/${model.id}`)
    expect(JSON.stringify(body)).not.toContain(model.baseUrl)
    expect(JSON.stringify(body)).not.toContain('apiKey')
    expect(JSON.stringify(body)).not.toContain('headers')
  })

  test('GatewayClient loads a safe project catalog and resolves models without local credentials', async () => {
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())
    const catalog = await client.loadProjectModelCatalog()
    expect(catalog.currentModelId).toBe(`${model.provider}/${model.id}`)
    expect(catalog.models[0]?.baseUrl).toBe('')
    expect(client.getProjectDefaultModelConfig().apiKey).toBe('')
    expect(client.resolveProjectModel(model.id, model.api, String(model.provider)).model).toMatchObject({
      id: model.id,
      provider: model.provider,
      api: model.api,
    })
    expect(() => client.resolveProjectModel('missing-model')).toThrow('was not found in the Model Gateway catalog')
  })

  test('GatewayClient preserves slash-containing model IDs and resolves fully qualified IDs without false ambiguity', async () => {
    const openRouterModel = { ...model, id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' } as Model<any>
    runtimeState.runtime.getModels = () => [model, openRouterModel]
    runtimeState.runtime.getCurrentModel = () => model
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())

    const catalog = await client.loadProjectModelCatalog()

    expect(catalog.models[1]).toMatchObject({ id: 'deepseek/deepseek-v4-pro', provider: 'openrouter' })
    expect(client.getProjectDefaultModelConfig().model).toMatchObject({ id: model.id, provider: model.provider })
    expect(client.resolveProjectModel('openrouter/deepseek/deepseek-v4-pro').model).toMatchObject({
      id: 'deepseek/deepseek-v4-pro',
      provider: 'openrouter',
    })
  })

  test('private auth RPC lists provider methods, streams prompts, keeps entered secrets off the response, and supports logout', async () => {
    let storedPromptValue = ''
    let loggedOutProvider = ''
    const authRuntime = createRuntime({
      getProviders: () => [{
        id: 'test-provider',
        name: 'Test Provider',
        authChoices: [{ value: 'api_key', label: 'API key', description: 'Provider key' }],
      }],
      checkAuth: async () => ({ type: 'api_key' as const }),
      async login(providerId, authType, interaction) {
        expect(providerId).toBe('test-provider')
        expect(authType).toBe('api_key')
        interaction.notify({ type: 'progress', message: 'Waiting for API key.' })
        storedPromptValue = await interaction.prompt({ type: 'secret', message: 'API key' })
      },
      async logout(providerId) { loggedOutProvider = providerId },
    })
    const authServer = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: authRuntime.runtime, port: 0 })
    const authBaseUrl = `http://${authServer.hostname}:${authServer.port}`
    let authWire: Promise<string> | undefined
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (new URL(String(input)).pathname === '/internal/v1/auth/login') authWire = response.clone().text()
      return response
    }
    try {
      const client = new GatewayClient({ host: '127.0.0.1', port: authServer.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl: authBaseUrl }, recordingFetch, process.cwd())
      await expect(client.listProviders()).resolves.toMatchObject([{ id: 'test-provider', name: 'Test Provider' }])
      await expect(client.getAuthStatus()).resolves.toEqual([{ providerId: 'test-provider', configured: true, type: 'api_key' }])
      const notifications: unknown[] = []
      await client.login('test-provider', 'api_key', {
        signal: new AbortController().signal,
        async prompt(prompt) {
          expect(prompt.type).toBe('secret')
          return 'private-test-secret'
        },
        notify(event) { notifications.push(event) },
      })
      expect(storedPromptValue).toBe('private-test-secret')
      expect(notifications).toEqual([{ type: 'progress', message: 'Waiting for API key.' }])
      expect(await authWire).not.toContain('private-test-secret')
      await client.logout('test-provider')
      expect(loggedOutProvider).toBe('test-provider')
    } finally {
      await authServer.stop()
    }
  })

  test('GatewayClient preserves Pi stream events and completion results over RPC', async () => {
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())
    const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 1 }] }
    const completed = await client.completeSimple(model, context)
    expect(completed.content[0]).toMatchObject({ type: 'text', text: 'gateway reply' })

    const events: AssistantMessageEvent[] = []
    for await (const event of client.streamSimple(model, context)) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['start', 'text_start', 'text_delta', 'text_delta', 'text_end', 'done'])
  })

  test('private model RPC accepts large pre-compaction context while public API keeps its smaller body limit', async () => {
    const longPrompt = 'x'.repeat(2 * 1024 * 1024 + 128)
    const context = { messages: [{ role: 'user' as const, content: longPrompt, timestamp: 1 }] }
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())

    const completed = await client.completeSimple(model, context)
    expect(completed.content[0]).toMatchObject({ type: 'text', text: 'gateway reply' })
    const events: AssistantMessageEvent[] = []
    for await (const event of client.streamSimple(model, context)) events.push(event)
    expect(events.at(-1)?.type).toBe('done')

    const publicResponse = await post('/v1/chat/completions', {
      model: `${model.provider}/${model.id}`,
      messages: [{ role: 'user', content: longPrompt }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(publicResponse.status).toBe(413)
  })

  test('private RPC surfaces bounded gateway HTTP diagnostics for completion and stream failures', async () => {
    const limited = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: runtimeState.runtime, port: 0, maxInternalRequestBytes: 128 })
    try {
      const limitedUrl = `http://${limited.hostname}:${limited.port}`
      const client = new GatewayClient({
        host: '127.0.0.1', port: limited.port, token: TOKEN, rpcToken: RPC_TOKEN,
        baseUrl: limitedUrl,
      }, fetch, process.cwd())
      const context = { messages: [{ role: 'user' as const, content: 'x'.repeat(200), timestamp: 1 }] }

      await expect(client.completeSimple(model, context)).rejects.toThrow('Model Gateway completion request failed (HTTP 413): Request body exceeds the configured size limit.')
      const events: AssistantMessageEvent[] = []
      for await (const event of client.streamSimple(model, context)) events.push(event)
      const error = events.find((event) => event.type === 'error')
      expect(error?.type === 'error' ? error.error.errorMessage : '').toBe('Model Gateway stream request failed (HTTP 413): Request body exceeds the configured size limit.')
    } finally {
      await limited.stop()
    }
  })

  test('GatewayClient handshake verifies public health, model discovery, and private RPC', async () => {
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())
    await expect(client.handshake()).resolves.toEqual({ protocolVersion: 1, modelCount: 1 })
  })

  test('GatewayClient handshake rejects invalid public and private credentials', async () => {
    const badPublicToken = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: 'wrong-public-token', rpcToken: RPC_TOKEN, baseUrl }, fetch, process.cwd())
    await expect(badPublicToken.handshake()).rejects.toThrow('Gateway model-list check failed (HTTP 401).')

    const badRpcToken = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: 'wrong-rpc-token', baseUrl }, fetch, process.cwd())
    await expect(badRpcToken.handshake()).rejects.toThrow('Gateway private RPC handshake failed (HTTP 401).')
  })

  test('GatewayClient handshake rejects an incompatible gateway protocol', async () => {
    const incompatibleFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init)
      if (new URL(String(input)).pathname !== '/healthz') return response
      return Response.json({ status: 'ok', protocol_version: 999 })
    }
    const client = new GatewayClient({ host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }, incompatibleFetch, process.cwd())
    await expect(client.handshake()).rejects.toThrow('Gateway protocol mismatch (expected 1, received 999).')
  })

  test('default transport falls back when a stale daemon has health but no private RPC handshake route', async () => {
    const connection = { host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }
    const staleDaemonFetch: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/internal/v1/handshake') return new Response('Not found.', { status: 404 })
      return fetch(input, init)
    }

    const transport = await initializeTuiModelTransport(async () => connection, staleDaemonFetch, process.cwd())

    expect(transport.mode).toBe('direct')
    if (transport.mode === 'direct') {
      expect(transport.reason).toContain('Gateway private RPC handshake failed (HTTP 404).')
      expect(transport.reason).toContain('microcode gateway stop')
    }
  })

  test('default TUI transport selects the gateway after handshake and direct mode after failure', async () => {
    const connection = { host: '127.0.0.1', port: handle.port, token: TOKEN, rpcToken: RPC_TOKEN, baseUrl }
    const gateway = await initializeTuiModelTransport(async () => connection, fetch, process.cwd())
    expect(gateway.mode).toBe('gateway')
    if (gateway.mode === 'gateway') expect(gateway).toMatchObject({ protocolVersion: 1, modelCount: 1 })

    const rejectedConnection = { ...connection, rpcToken: 'wrong-rpc-token' }
    const direct = await initializeTuiModelTransport(async () => rejectedConnection, fetch, process.cwd())
    expect(direct.mode).toBe('direct')
    if (direct.mode === 'direct') expect(direct.reason).toContain('Gateway private RPC handshake failed (HTTP 401).')

    const invalidModel = await initializeTuiModelTransport(async () => connection, fetch, process.cwd(), 'not-in-catalog')
    expect(invalidModel.mode).toBe('direct')
    if (invalidModel.mode === 'direct') expect(invalidModel.reason).toContain('was not found in the Model Gateway catalog')
  })

  test('client disconnect aborts an active upstream stream and releases the request slot', async () => {
    let capturedSignal: AbortSignal | undefined
    const blockingRuntime = createRuntime({
      async *stream(_selectedModel, _context, options) {
        capturedSignal = options.signal
        yield messageEvents()[0]!
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    })
    const active = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: blockingRuntime.runtime, port: 0, maxConcurrentRequests: 1 })
    try {
      const activeUrl = `http://${active.hostname}:${active.port}`
      const body = JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }], stream: true })
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: active.hostname, port: active.port }, () => {
          socket.write([
            'POST /v1/chat/completions HTTP/1.1',
            `Host: ${active.hostname}:${active.port}`,
            `Authorization: Bearer ${TOKEN}`,
            'Content-Type: application/json',
            `Content-Length: ${Buffer.byteLength(body)}`,
            'Connection: close',
            '',
            body,
          ].join('\r\n'))
        })
        let receivedHeaders = false
        socket.on('data', (chunk) => {
          const text = chunk.toString()
          const headerEnd = text.indexOf('\r\n\r\n')
          if (!receivedHeaders && headerEnd >= 0) {
            receivedHeaders = true
            if (text.length > headerEnd + 4) {
              socket.destroy()
              resolve()
            }
          } else if (receivedHeaders && text.length > 0) {
            socket.destroy()
            resolve()
          }
        })
        socket.on('error', reject)
        socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('Timed out waiting for the gateway stream.')) })
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(capturedSignal?.aborted).toBe(true)
      const second = await fetch(`${activeUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }] }),
      })
      expect(second.status).toBe(200)
    } finally {
      await active.stop()
    }
  })

  test('gateway stop aborts active provider work with a terminal protocol error', async () => {
    let capturedSignal: AbortSignal | undefined
    const blockingRuntime = createRuntime({
      async *stream(_selectedModel, _context, options) {
        capturedSignal = options.signal
        yield messageEvents()[0]!
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    })
    const active = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: blockingRuntime.runtime, port: 0 })
    try {
      const activeUrl = `http://${active.hostname}:${active.port}`
      const response = await fetch(`${activeUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }], stream: true }),
      })
      const reader = response.body!.getReader()
      await reader.read()
      const stopped = await fetch(`${activeUrl}/gateway/stop`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(stopped.status).toBe(202)
      expect(capturedSignal?.aborted).toBe(true)
      let streamText = ''
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        streamText += new TextDecoder().decode(chunk.value)
      }
      expect(streamText).toContain('[DONE]')
      expect(streamText).toContain('server_error')
    } finally {
      await active.stop()
    }
  })

  test('rejects missing/incorrect auth, unknown models, wrong RPC versions, and unsupported methods before inference', async () => {
    const body = { model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }] }
    expect((await post('/v1/chat/completions', body)).status).toBe(401)
    expect((await post('/v1/chat/completions', { ...body, model: 'not-a-model' }, { authorization: `Bearer ${TOKEN}` })).status).toBe(404)
    expect((await post('/internal/v1/complete', { model: `${model.provider}/${model.id}`, context: { messages: [] } }, { authorization: `Bearer ${RPC_TOKEN}`, 'x-microcode-rpc-version': '999' })).status).toBe(426)
    expect((await post('/internal/v1/complete', { model: `${model.provider}/${model.id}`, context: { messages: [] } }, { authorization: `Bearer ${TOKEN}`, 'x-microcode-rpc-version': '1' })).status).toBe(401)
    expect((await fetch(`${baseUrl}/v1/chat/completions`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405)
    expect(runtimeState.calls).toHaveLength(0)
  })

  test('rejects oversized payloads and Responses hosted tools instead of silently ignoring them', async () => {
    const limited = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: runtimeState.runtime, port: 0, maxRequestBytes: 128 })
    try {
      const limitedUrl = `http://${limited.hostname}:${limited.port}`
      const tooLarge = await fetch(`${limitedUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'x'.repeat(200) }] }),
      })
      expect(tooLarge.status).toBe(413)
    } finally {
      await limited.stop()
    }
    const hostedTool = await post('/v1/responses', {
      model: `${model.provider}/${model.id}`,
      input: 'hello',
      tools: [{ type: 'web_search' }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(hostedTool.status).toBe(400)
    const activeHostedTool = await post('/v1/responses', {
      model: `${model.provider}/${model.id}`,
      input: 'hello',
      tools: [{ type: 'web_search', external_web_access: true }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(activeHostedTool.status).toBe(400)
    expect(runtimeState.calls).toHaveLength(0)
  })

  test('rejects oversized tool schemas before starting model inference', async () => {
    const response = await post('/v1/chat/completions', {
      model: `${model.provider}/${model.id}`,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'huge_schema', parameters: { type: 'object', description: 'x'.repeat(70 * 1024) } } }],
    }, { authorization: `Bearer ${TOKEN}` })
    expect(response.status).toBe(413)
    expect((await response.json()).error.message).toContain('per-tool schema limit')
    expect(runtimeState.calls).toHaveLength(0)
  })

  test('terminates idle model streams with a timeout error and aborts provider work', async () => {
    let providerSignal: AbortSignal | undefined
    const idleRuntime = createRuntime({
      async *stream(_selectedModel, _context, options) {
        providerSignal = options.signal
        yield { type: 'start', partial: assistantMessage() }
        await new Promise<void>((resolve) => options.signal?.addEventListener('abort', () => resolve(), { once: true }))
        options.signal?.throwIfAborted()
      },
    })
    const idleServer = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: idleRuntime.runtime, port: 0, maxStreamIdleMs: 20 })
    try {
      const response = await fetch(`http://${idleServer.hostname}:${idleServer.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }], stream: true }),
      })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('server_error')
      expect(providerSignal?.aborted).toBe(true)
    } finally {
      await idleServer.stop()
    }
  })

  test('rejects models that cannot honor a requested reasoning control', async () => {
    const nonReasoning = { ...model, reasoning: false } as Model<any>
    const noReasoningRuntime = createRuntime({
      getModels: () => [nonReasoning],
      resolveModel: () => nonReasoning,
    })
    const other = createGatewayServer({ token: TOKEN, rpcToken: RPC_TOKEN, runtime: noReasoningRuntime.runtime, port: 0 })
    try {
      const response = await fetch(`http://${other.hostname}:${other.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `${model.provider}/${model.id}`, messages: [{ role: 'user', content: 'hello' }], reasoning_effort: 'high' }),
      })
      expect(response.status).toBe(400)
      expect(noReasoningRuntime.calls).toHaveLength(0)
    } finally {
      await other.stop()
    }
  })
})
