import type {
  AssistantMessage,
  Api,
  Context,
  ImageContent,
  JsonObject,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import type { GatewayChatRequest, GatewayRequestOptions } from './types.ts'

type JsonRecord = Record<string, unknown>

function fail(message: string, status = 400): never {
  throw new GatewayProtocolError(message, status)
}

function rejectRequestedOptions(body: JsonRecord, fields: string[], dialect: string): void {
  const requested = fields.filter((field) => body[field] !== undefined && body[field] !== null)
  if (requested.length) fail(`${dialect} option(s) are not supported by this gateway: ${requested.join(', ')}.`)
}

export class GatewayProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'GatewayProtocolError'
  }
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`)
  return value as JsonRecord
}

function string(value: unknown, label: string, optional = false): string {
  if (optional && value === undefined) return ''
  if (typeof value !== 'string') fail(`${label} must be a string.`)
  return value
}

function contentText(value: unknown, label: string): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) fail(`${label} must be text or an array of content blocks.`)
  return value.map((block, index) => {
    const item = record(block, `${label}[${index}]`)
    if (item.type === 'text' || item.type === 'input_text' || item.type === 'output_text') {
      return string(item.text, `${label}[${index}].text`)
    }
    fail(`Unsupported content block in ${label}: ${String(item.type)}.`)
  }).join('')
}

function imageFromDataUrl(url: unknown, label: string): ImageContent {
  if (typeof url !== 'string') fail(`${label} must be a data URL.`)
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+=*)$/i.exec(url)
  if (!match) fail(`${label} must be a base64 PNG, JPEG, GIF, or WebP data URL; remote image URLs are not fetched.`)
  return { type: 'image', mimeType: match[1]!.toLowerCase(), data: match[2]! }
}

function openAiContent(value: unknown, label: string): string | (TextContent | ImageContent)[] {
  if (typeof value === 'string' || value === null) return value ?? ''
  if (!Array.isArray(value)) fail(`${label} must be a string or content array.`)
  return value.map((raw, index) => {
    const block = record(raw, `${label}[${index}]`)
    if (block.type === 'text' || block.type === 'input_text') {
      return { type: 'text' as const, text: string(block.text, `${label}[${index}].text`) }
    }
    if (block.type === 'image_url') {
      const image = typeof block.image_url === 'string'
        ? block.image_url
        : record(block.image_url, `${label}[${index}].image_url`).url
      return imageFromDataUrl(image, `${label}[${index}].image_url`)
    }
    fail(`Unsupported content block in ${label}: ${String(block.type)}.`)
  })
}

function anthropicContent(value: unknown, label: string, role: 'user' | 'assistant'): Message[] {
  const blocks = typeof value === 'string' ? [{ type: 'text', text: value }] : value
  if (!Array.isArray(blocks)) fail(`${label} must be text or an array of content blocks.`)
  const messages: Message[] = []
  let ordinary: (TextContent | ImageContent | ThinkingContent | ToolCall)[] = []
  const flush = () => {
    if (ordinary.length === 0) return
    if (role === 'user') messages.push({ role, content: ordinary as (TextContent | ImageContent)[], timestamp: Date.now() })
    else messages.push({
      role,
      content: ordinary as AssistantMessage['content'],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'gateway-input',
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    })
    ordinary = []
  }
  for (let index = 0; index < blocks.length; index++) {
    const block = record(blocks[index], `${label}[${index}]`)
    if (block.type === 'text') {
      ordinary.push({ type: 'text', text: string(block.text, `${label}[${index}].text`) })
    } else if (block.type === 'image' && role === 'user') {
      const source = record(block.source, `${label}[${index}].source`)
      if (source.type !== 'base64') fail('Remote Anthropic image sources are not fetched by the gateway.')
      const mimeType = string(source.media_type, `${label}[${index}].source.media_type`)
      if (!/^image\/(png|jpeg|gif|webp)$/i.test(mimeType)) fail('Unsupported image media type.')
      ordinary.push({ type: 'image', mimeType: mimeType.toLowerCase(), data: string(source.data, `${label}[${index}].source.data`) })
    } else if (block.type === 'thinking' && role === 'assistant') {
      ordinary.push({ type: 'thinking', thinking: string(block.thinking, `${label}[${index}].thinking`), ...(typeof block.signature === 'string' ? { thinkingSignature: block.signature } : {}) })
    } else if (block.type === 'redacted_thinking' && role === 'assistant') {
      ordinary.push({ type: 'thinking', thinking: '', thinkingSignature: string(block.data, `${label}[${index}].data`), redacted: true })
    } else if (block.type === 'tool_use' && role === 'assistant') {
      const input = record(block.input ?? {}, `${label}[${index}].input`)
      ordinary.push({ type: 'toolCall', id: string(block.id, `${label}[${index}].id`), name: string(block.name, `${label}[${index}].name`), arguments: input as JsonObject })
    } else if (block.type === 'tool_result' && role === 'user') {
      flush()
      const resultContent = typeof block.content === 'string'
        ? [{ type: 'text' as const, text: block.content }]
        : Array.isArray(block.content)
          ? block.content.map((part, partIndex) => {
              const item = record(part, `${label}[${index}].content[${partIndex}]`)
              if (item.type === 'text') return { type: 'text' as const, text: string(item.text, `${label}[${index}].content[${partIndex}].text`) }
              if (item.type === 'image') {
                const source = record(item.source, `${label}[${index}].content[${partIndex}].source`)
                if (source.type !== 'base64') fail('Remote Anthropic tool-result images are not fetched by the gateway.')
                return { type: 'image' as const, mimeType: string(source.media_type, 'tool-result media_type'), data: string(source.data, 'tool-result image data') }
              }
              fail(`Unsupported tool result block: ${String(item.type)}.`)
            })
          : fail(`${label}[${index}].content must be text or content blocks.`)
      messages.push({
        role: 'toolResult',
        toolCallId: string(block.tool_use_id, `${label}[${index}].tool_use_id`),
        toolName: typeof block.name === 'string' ? block.name : 'tool',
        content: resultContent,
        isError: block.is_error === true,
        timestamp: Date.now(),
      })
    } else {
      fail(`Unsupported ${role} content block: ${String(block.type)}.`)
    }
  }
  flush()
  return messages
}

function parseToolArguments(value: unknown, label: string): JsonObject {
  let parsed: unknown = value
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { fail(`${label} must contain valid JSON.`) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} must decode to a JSON object.`)
  return parsed as JsonObject
}

function parseTools(
  value: unknown,
  dialect: 'openai' | 'anthropic' | 'responses',
  responsesToolNamespaces?: Map<string, { namespace: string; name: string }>,
): Tool[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('tools must be an array.')
  if (value.length > 128) fail('At most 128 tools may be declared.')
  let totalSchemaBytes = 0
  let toolCount = 0
  const names = new Set<string>()
  const tools: Tool[] = []
  const parameters = (schema: unknown, label: string): Tool['parameters'] => {
    const parsed = record(schema ?? { type: 'object' }, label) as Tool['parameters']
    const size = Buffer.byteLength(JSON.stringify(parsed), 'utf8')
    if (size > 64 * 1024) fail(`${label} exceeds the 65536-byte per-tool schema limit.`, 413)
    totalSchemaBytes += size
    if (totalSchemaBytes > 256 * 1024) fail('Tool schemas exceed the 262144-byte aggregate limit.', 413)
    return parsed
  }
  const addTool = (name: string, description: unknown, schema: unknown, label: string) => {
    if (names.has(name)) fail(`Tool name "${name}" is duplicated after Responses namespace normalization.`)
    names.add(name)
    tools.push({ name, description: typeof description === 'string' ? description : '', parameters: parameters(schema, label) })
    toolCount++
    if (toolCount > 128) fail('At most 128 tools may be declared.')
  }
  for (let index = 0; index < value.length; index++) {
    const item = record(value[index], `tools[${index}]`)
    if (dialect === 'openai') {
      if (item.type !== 'function') fail('Only function tools are supported.')
      const fn = record(item.function, `tools[${index}].function`)
      addTool(string(fn.name, `tools[${index}].function.name`), fn.description, fn.parameters, `tools[${index}].function.parameters`)
      continue
    }
    if (dialect === 'responses') {
      if (item.type === 'function') {
        if (item.strict !== undefined && typeof item.strict !== 'boolean') fail(`tools[${index}].strict must be a boolean.`)
        addTool(string(item.name, `tools[${index}].name`), item.description, item.parameters, `tools[${index}].parameters`)
        continue
      }
      if (item.type === 'namespace') {
        const namespace = string(item.name, `tools[${index}].name`)
        if (!Array.isArray(item.tools)) fail(`tools[${index}].tools must be an array.`)
        for (let nestedIndex = 0; nestedIndex < item.tools.length; nestedIndex++) {
          const nested = record(item.tools[nestedIndex], `tools[${index}].tools[${nestedIndex}]`)
          if (nested.type !== 'function') fail(`Unsupported Responses namespace tool type "${String(nested.type)}"; only caller-owned function tools are supported.`)
          if (nested.strict !== undefined && typeof nested.strict !== 'boolean') fail(`tools[${index}].tools[${nestedIndex}].strict must be a boolean.`)
          const name = string(nested.name, `tools[${index}].tools[${nestedIndex}].name`)
          const normalizedName = `${namespace}__${name}`
          responsesToolNamespaces?.set(normalizedName, { namespace, name })
          addTool(normalizedName, nested.description, nested.parameters, `tools[${index}].tools[${nestedIndex}].parameters`)
        }
        continue
      }
      // Codex advertises this disabled hosted tool even when search is off.
      // Accept only the explicit disabled marker; enabled/extended variants remain unsupported.
      if (item.type === 'web_search' && item.external_web_access === false && Object.keys(item).every((key) => key === 'type' || key === 'external_web_access')) continue
      const unsupportedType = typeof item.type === 'string' ? item.type.slice(0, 80) : 'missing type'
      fail(`Unsupported Responses tool type "${unsupportedType}"; hosted tools are not executed by this gateway.`)
    }
    addTool(string(item.name, `tools[${index}].name`), item.description, item.input_schema, `tools[${index}].input_schema`)
  }
  return tools
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
}

function requestOptions(body: JsonRecord, dialect: 'openai' | 'anthropic' | 'responses'): GatewayRequestOptions {
  let maxTokens: unknown
  let reasoning: GatewayRequestOptions['reasoning']
  let reasoningSummary: GatewayRequestOptions['reasoningSummary']
  let temperature: unknown
  let toolChoice: GatewayRequestOptions['toolChoice']
  let parallelToolCalls: GatewayRequestOptions['parallelToolCalls']
  let samplingParams: Record<string, unknown> | undefined

  if (dialect === 'openai') {
    rejectRequestedOptions(body, ['response_format', 'logprobs', 'top_logprobs', 'logit_bias', 'seed', 'functions', 'function_call'], 'Chat Completions')
    maxTokens = body.max_completion_tokens ?? body.max_tokens
    temperature = body.temperature
    if (body.top_p !== undefined || body.top_k !== undefined || body.stop !== undefined || body.frequency_penalty !== undefined || body.presence_penalty !== undefined) {
      samplingParams = Object.fromEntries(['top_p', 'top_k', 'stop', 'frequency_penalty', 'presence_penalty'].filter((key) => body[key] !== undefined).map((key) => [key, body[key]]))
    }
    if (body.reasoning_effort !== undefined) {
      if (body.reasoning_effort === 'minimal' || body.reasoning_effort === 'low' || body.reasoning_effort === 'medium' || body.reasoning_effort === 'high' || body.reasoning_effort === 'xhigh' || body.reasoning_effort === 'max') reasoning = body.reasoning_effort
      else if (body.reasoning_effort !== 'none') fail('Unsupported Chat Completions reasoning_effort.')
    }
    if (body.tool_choice === 'none') toolChoice = 'none'
    else if (body.tool_choice === 'auto' || body.tool_choice === undefined) toolChoice = 'auto'
    else fail('Forced tool selection is not supported by the normalized Pi tool-choice interface.')
  } else if (dialect === 'anthropic') {
    maxTokens = body.max_tokens
    temperature = body.temperature
    if (body.top_p !== undefined || body.top_k !== undefined || body.stop_sequences !== undefined) {
      samplingParams = Object.fromEntries([['top_p', body.top_p], ['top_k', body.top_k], ['stop', body.stop_sequences]].filter(([, value]) => value !== undefined))
    }
    if (body.thinking !== undefined) {
      const thinking = record(body.thinking, 'thinking')
      if (thinking.display !== undefined && thinking.display !== null && thinking.display !== 'summarized' && thinking.display !== 'omitted') {
        fail('Unsupported Anthropic thinking.display value.')
      }
      if (thinking.type === 'adaptive') {
        const effort = body.output_config === undefined ? 'medium' : record(body.output_config, 'output_config').effort
        if (effort !== 'minimal' && effort !== 'low' && effort !== 'medium' && effort !== 'high' && effort !== 'max') fail('Unsupported Anthropic output_config.effort.')
        reasoning = effort
      } else if (thinking.type === 'enabled') {
        fail('Anthropic fixed-budget thinking is not supported by the normalized Pi reasoning interface.')
      }
      else if (thinking.type === 'disabled') {
        if (thinking.display !== undefined && thinking.display !== null) fail('Anthropic thinking.display requires adaptive thinking.')
      } else fail('Unsupported Anthropic thinking mode.')
    }
    const choice = body.tool_choice
    if (choice === undefined || record(choice, 'tool_choice').type === 'auto') toolChoice = 'auto'
    else if (record(choice, 'tool_choice').type === 'none') toolChoice = 'none'
    else fail('Forced Anthropic tool selection is not supported by the normalized Pi tool-choice interface.')
  } else {
    rejectRequestedOptions(body, ['previous_response_id', 'max_tool_calls', 'prompt'], 'Responses')
    if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be a boolean.')
    parallelToolCalls = body.parallel_tool_calls as boolean | undefined
    if (body.text !== undefined) {
      const text = record(body.text, 'text')
      if (Object.keys(text).some((key) => key !== 'verbosity')) fail('Only Responses text.verbosity is recognized.')
      if (text.verbosity !== undefined && text.verbosity !== 'low') fail('Only Responses text.verbosity="low" is supported by the normalized runtime.')
    }
    if (body.include !== undefined) {
      if (!Array.isArray(body.include) || body.include.some((item) => typeof item !== 'string')) fail('Responses include must be an array of strings.')
      const unsupported = body.include.filter((item) => item !== 'reasoning.encrypted_content')
      if (unsupported.length) fail(`Responses include field(s) are not supported: ${unsupported.join(', ')}.`)
      // Encrypted reasoning payloads are deliberately not produced or exposed by this gateway.
    }
    if (body.prompt_cache_key !== undefined && (typeof body.prompt_cache_key !== 'string' || body.prompt_cache_key.length > 1024)) fail('prompt_cache_key must be a string no longer than 1024 characters.')
    if (body.client_metadata !== undefined) record(body.client_metadata, 'client_metadata')
    if (body.store === true) fail('Responses stored conversation state is not supported; send the full input on each request.')
    maxTokens = body.max_output_tokens
    temperature = body.temperature
    const reasoningValue = body.reasoning
    if (reasoningValue !== undefined) {
      const reasoningObject = record(reasoningValue, 'reasoning')
      const effort = reasoningObject.effort
      if (reasoningObject.context !== undefined && reasoningObject.context !== 'auto') fail('Only Responses reasoning.context="auto" is supported by the normalized runtime.')
      if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') reasoning = effort
      else if (effort !== undefined && effort !== 'none') fail('Unsupported Responses reasoning effort.')
      const summary = reasoningObject.summary
      if (summary === 'auto' || summary === 'concise' || summary === 'detailed') reasoningSummary = summary
      else if (summary === 'none') reasoningSummary = undefined
      else if (summary !== undefined && summary !== null) fail('Unsupported Responses reasoning.summary value.')
    }
    if (body.tool_choice === undefined || body.tool_choice === 'auto') toolChoice = 'auto'
    else if (body.tool_choice === 'none') toolChoice = 'none'
    else fail('Forced Responses tool selection is not supported by the normalized Pi tool-choice interface.')
  }

  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1 || (maxTokens as number) > 131072)) fail('Output token limit must be an integer between 1 and 131072.')
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) fail('temperature must be a number between 0 and 2.')
  if (samplingParams?.top_p !== undefined && (typeof samplingParams.top_p !== 'number' || samplingParams.top_p < 0 || samplingParams.top_p > 1)) fail('top_p must be a number between 0 and 1.')
  if (samplingParams?.top_k !== undefined && (!Number.isInteger(samplingParams.top_k) || (samplingParams.top_k as number) < 1)) fail('top_k must be a positive integer.')
  const stop = samplingParams?.stop
  if (stop !== undefined && !(typeof stop === 'string' || (Array.isArray(stop) && stop.every((item) => typeof item === 'string')))) fail('stop/stop_sequences must be a string or an array of strings.')
  for (const field of ['frequency_penalty', 'presence_penalty'] as const) {
    const value = samplingParams?.[field]
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < -2 || value > 2)) fail(`${field} must be a number between -2 and 2.`)
  }
  return {
    ...(maxTokens === undefined ? {} : { maxTokens: maxTokens as number }),
    ...(temperature === undefined ? {} : { temperature: temperature as number }),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
    ...(samplingParams ? { samplingParams } : {}),
  }
}

function streamFlag(body: JsonRecord): boolean {
  if (body.stream === undefined) return false
  if (typeof body.stream !== 'boolean') fail('stream must be a boolean.')
  return body.stream
}

function modelField(body: JsonRecord): string {
  const model = string(body.model, 'model')
  if (!model.trim()) fail('model must not be empty.')
  return model
}

function systemMessage(content: string): Message {
  return { role: 'system', content, timestamp: Date.now() }
}

export function parseOpenAiChatRequest(value: unknown): GatewayChatRequest {
  const body = record(value, 'request')
  if (body.n !== undefined && body.n !== 1) fail('Only one Chat Completions choice (n=1) is supported.')
  if (body.parallel_tool_calls === false) fail('parallel_tool_calls=false is not supported by this gateway.')
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 500) fail('messages must contain between 1 and 500 entries.')
  const messages: Message[] = []
  for (let index = 0; index < body.messages.length; index++) {
    const item = record(body.messages[index], `messages[${index}]`)
    const role = string(item.role, `messages[${index}].role`)
    const timestamp = Date.now()
    if (role === 'system' || role === 'developer') {
      messages.push(systemMessage(contentText(item.content, `messages[${index}].content`)))
    } else if (role === 'user') {
      messages.push({ role: 'user', content: openAiContent(item.content, `messages[${index}].content`) as string | (TextContent | ImageContent)[], timestamp })
    } else if (role === 'assistant') {
      const content = item.content === null || item.content === undefined
        ? []
        : typeof item.content === 'string'
          ? [{ type: 'text' as const, text: item.content }]
          : openAiContent(item.content, `messages[${index}].content`) as (TextContent | ImageContent)[]
      const assistantContent: AssistantMessage['content'] = content.map((block) => block.type === 'text' ? block : { type: 'text', text: '[image omitted from assistant history]' })
      if (Array.isArray(item.tool_calls)) {
        for (let callIndex = 0; callIndex < item.tool_calls.length; callIndex++) {
          const call = record(item.tool_calls[callIndex], `messages[${index}].tool_calls[${callIndex}]`)
          if (call.type !== 'function') fail('Only function tool calls are supported.')
          const fn = record(call.function, `messages[${index}].tool_calls[${callIndex}].function`)
          assistantContent.push({ type: 'toolCall', id: string(call.id, 'tool call id'), name: string(fn.name, 'tool name'), arguments: parseToolArguments(fn.arguments, 'tool arguments') })
        }
      }
      if (typeof item.reasoning_content === 'string') assistantContent.unshift({ type: 'thinking', thinking: item.reasoning_content })
      messages.push({ role: 'assistant', content: assistantContent, api: 'openai-completions', provider: 'openai', model: 'gateway-input', usage: emptyUsage(), stopReason: 'stop', timestamp })
    } else if (role === 'tool') {
      messages.push({ role: 'toolResult', toolCallId: string(item.tool_call_id, `messages[${index}].tool_call_id`), toolName: typeof item.name === 'string' ? item.name : 'tool', content: [{ type: 'text', text: contentText(item.content, `messages[${index}].content`) }], isError: false, timestamp })
    } else {
      fail(`Unsupported chat message role: ${role}.`)
    }
  }
  const tools = parseTools(body.tools, 'openai')
  const context: Context = { messages, ...(tools ? { tools } : {}) }
  return { modelId: modelField(body), context, options: requestOptions(body, 'openai'), stream: streamFlag(body) }
}

export function parseAnthropicRequest(value: unknown): GatewayChatRequest {
  const body = record(value, 'request')
  rejectRequestedOptions(body, ['context_management', 'container', 'mcp_servers'], 'Anthropic Messages')
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 500) fail('messages must contain between 1 and 500 entries.')
  const messages: Message[] = []
  if (body.system !== undefined) messages.push(systemMessage(contentText(body.system, 'system')))
  for (let index = 0; index < body.messages.length; index++) {
    const item = record(body.messages[index], `messages[${index}]`)
    const role = string(item.role, `messages[${index}].role`)
    if (role !== 'user' && role !== 'assistant') fail(`Unsupported Anthropic message role: ${role}.`)
    messages.push(...anthropicContent(item.content, `messages[${index}].content`, role))
  }
  const tools = parseTools(body.tools, 'anthropic')
  const context: Context = { messages, ...(tools ? { tools } : {}) }
  const thinking = body.thinking === undefined ? undefined : record(body.thinking, 'thinking')
  const anthropicThinkingDisplay = thinking?.type === 'adaptive' && (thinking.display === 'summarized' || thinking.display === 'omitted')
    ? thinking.display
    : undefined
  return {
    modelId: modelField(body),
    context,
    options: requestOptions(body, 'anthropic'),
    stream: streamFlag(body),
    ...(anthropicThinkingDisplay ? { anthropicThinkingDisplay } : {}),
  }
}

export function parseResponsesRequest(value: unknown): GatewayChatRequest {
  const body = record(value, 'request')
  if (body.store !== undefined && typeof body.store !== 'boolean') fail('store must be a boolean.')
  const input = body.input
  if (typeof input !== 'string' && !Array.isArray(input)) fail('input must be a string or array.')
  const messages: Message[] = []
  if (body.instructions !== undefined) messages.push(systemMessage(contentText(body.instructions, 'instructions')))
  const calls = new Map<string, string>()
  const responsesToolNamespaces = new Map<string, { namespace: string; name: string }>()
  const additionalToolDeclarations: unknown[] = []
  const entries = typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : input
  if (entries.length > 500) fail('input may contain at most 500 entries.')
  for (let index = 0; index < entries.length; index++) {
    const item = record(entries[index], `input[${index}]`)
    if (item.type === 'additional_tools') {
      if (item.role !== undefined && item.role !== 'developer') fail(`input[${index}].role must be developer for additional_tools.`)
      if (!Array.isArray(item.tools)) fail(`input[${index}].tools must be an array.`)
      additionalToolDeclarations.push(...item.tools)
      if (additionalToolDeclarations.length > 128) fail('At most 128 additional tools may be declared.')
    } else if (item.type === 'function_call') {
      const id = string(item.call_id ?? item.id, `input[${index}].call_id`)
      const name = string(item.name, `input[${index}].name`)
      const namespace = item.namespace === undefined ? undefined : string(item.namespace, `input[${index}].namespace`)
      const normalizedName = namespace ? `${namespace}__${name}` : name
      calls.set(id, normalizedName)
      messages.push({ role: 'assistant', content: [{ type: 'toolCall', id, name: normalizedName, arguments: parseToolArguments(item.arguments ?? '{}', `input[${index}].arguments`) }], api: 'openai-responses', provider: 'openai', model: 'gateway-input', usage: emptyUsage(), stopReason: 'toolUse', timestamp: Date.now() })
    } else if (item.type === 'function_call_output') {
      const id = string(item.call_id, `input[${index}].call_id`)
      messages.push({ role: 'toolResult', toolCallId: id, toolName: calls.get(id) ?? 'tool', content: [{ type: 'text', text: contentText(item.output, `input[${index}].output`) }], isError: false, timestamp: Date.now() })
    } else if (item.type === 'message' || item.type === undefined) {
      const role = item.role === 'developer' ? 'system' : item.role
      if (role === 'system') messages.push(systemMessage(contentText(item.content, `input[${index}].content`)))
      else if (role === 'user') messages.push({ role: 'user', content: openAiContent(item.content, `input[${index}].content`) as string | (TextContent | ImageContent)[], timestamp: Date.now() })
      else if (role === 'assistant') {
        const text = contentText(item.content, `input[${index}].content`)
        messages.push({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-responses', provider: 'openai', model: 'gateway-input', usage: emptyUsage(), stopReason: 'stop', timestamp: Date.now() })
      } else fail(`Unsupported Responses input role: ${String(role)}.`)
    } else {
      fail(`Unsupported Responses input item: ${String(item.type)}.`)
    }
  }
  const declaredTools = [
    ...(Array.isArray(body.tools) ? body.tools : body.tools === undefined ? [] : fail('tools must be an array when provided.')),
    ...additionalToolDeclarations,
  ]
  const tools = parseTools(declaredTools.length ? declaredTools : undefined, 'responses', responsesToolNamespaces)
  const context: Context = { messages, ...(tools ? { tools } : {}) }
  return {
    modelId: modelField(body), context, options: requestOptions(body, 'responses'), stream: streamFlag(body),
    ...(responsesToolNamespaces.size ? { responsesToolNamespaces } : {}),
  }
}

export function plainText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

export function usageForOpenAi(usage: Usage) {
  return { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.totalTokens }
}

export function serializeOpenAiChat(message: AssistantMessage, model: Model<Api>): JsonRecord {
  const calls = message.content.filter((block): block is ToolCall => block.type === 'toolCall')
  const choices: JsonRecord = {
    index: 0,
    message: {
      role: 'assistant',
      content: plainText(message) || null,
      ...(calls.length > 0 ? { tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
    },
    finish_reason: message.stopReason === 'toolUse' ? 'tool_calls' : message.stopReason === 'length' ? 'length' : 'stop',
  }
  const id = `chatcmpl_${crypto.randomUUID()}`
  return { id, object: 'chat.completion', created: Math.floor(message.timestamp / 1000), model: `${model.provider}/${model.id}`, choices: [choices], usage: usageForOpenAi(message.usage) }
}

export function serializeAnthropic(message: AssistantMessage, model: Model<Api>, thinkingDisplay: 'summarized' | 'omitted' = 'summarized'): JsonRecord {
  const content: JsonRecord[] = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'thinking' && block.redacted) content.push({ type: 'redacted_thinking', data: block.thinkingSignature ?? '' })
    else if (block.type === 'thinking' && thinkingDisplay === 'omitted') {
      if (block.thinkingSignature) content.push({ type: 'thinking', thinking: '', signature: block.thinkingSignature })
    } else if (block.type === 'thinking') content.push({ type: 'thinking', thinking: block.thinking, ...(block.thinkingSignature ? { signature: block.thinkingSignature } : {}) })
    else if (block.type === 'toolCall') content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.arguments })
  }
  return {
    id: `msg_${crypto.randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: `${model.provider}/${model.id}`,
    content,
    stop_reason: message.stopReason === 'toolUse' ? 'tool_use' : message.stopReason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: message.usage.input, output_tokens: message.usage.output },
  }
}

export function responsesToolName(name: string, namespaces?: ReadonlyMap<string, { namespace: string; name: string }>): JsonRecord {
  const mapped = namespaces?.get(name)
  return mapped ? { namespace: mapped.namespace, name: mapped.name } : { name }
}

export function serializeResponses(
  message: AssistantMessage,
  model: Model<Api>,
  includeReasoningSummary = false,
  namespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): JsonRecord {
  const output: JsonRecord[] = []
  const text = plainText(message)
  let pendingText = ''
  const flushText = () => {
    if (!pendingText) return
    output.push({ type: 'message', id: `msg_${crypto.randomUUID()}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: pendingText, annotations: [] }] })
    pendingText = ''
  }
  for (const block of message.content) {
    if (block.type === 'text') pendingText += block.text
    else if (block.type === 'toolCall') {
      flushText()
      output.push({ type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: block.id, ...responsesToolName(block.name, namespaces), arguments: JSON.stringify(block.arguments), status: 'completed' })
    } else if (block.type === 'thinking' && includeReasoningSummary && !block.redacted && block.thinking) {
      flushText()
      output.push({ type: 'reasoning', id: `rs_${crypto.randomUUID()}`, status: 'completed', summary: [{ type: 'summary_text', text: block.thinking }] })
    }
  }
  flushText()
  return {
    id: `resp_${crypto.randomUUID()}`,
    object: 'response',
    created_at: Math.floor(message.timestamp / 1000),
    status: 'completed',
    error: null,
    incomplete_details: message.stopReason === 'length' ? { reason: 'max_output_tokens' } : null,
    model: `${model.provider}/${model.id}`,
    output,
    output_text: text,
    usage: { input_tokens: message.usage.input, output_tokens: message.usage.output, total_tokens: message.usage.totalTokens },
  }
}
