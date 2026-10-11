import type { AssistantMessage, AssistantMessageEvent, Model } from '@earendil-works/pi-ai'
import { plainText, responsesToolName, serializeResponses } from './protocol.ts'
import type { GatewayDialect } from './types.ts'

export interface SseEvent {
  event?: string
  data: unknown
}

export interface GatewayStreamAdapter {
  convert(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<SseEvent>
}

function finishReason(reason: string): string {
  if (reason === 'toolUse') return 'tool_calls'
  if (reason === 'length') return 'length'
  return 'stop'
}

/** Owns the per-response state required to translate Pi events to Chat Completions chunks. */
export class OpenAiChatStreamAdapter implements GatewayStreamAdapter {
  private readonly id = `chatcmpl_${crypto.randomUUID()}`
  private created = Math.floor(Date.now() / 1000)
  private started = false
  private readonly toolIndexes = new Map<number, number>()
  private nextToolIndex = 0
  private readonly toolArgumentLengths = new Map<number, number>()

  constructor(private readonly model: Model<any>) {}

  async *convert(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<SseEvent> {
    const { model } = this
    for await (const event of events) {
      if (event.type === 'start') {
        this.created = Math.floor(event.partial.timestamp / 1000)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } }
        this.started = true
      } else if (event.type === 'text_delta') {
        if (!this.started) continue
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { content: event.delta }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_start') {
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'toolCall') continue
        const index = this.nextToolIndex++
        this.toolIndexes.set(event.contentIndex, index)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_delta') {
        const index = this.toolIndexes.get(event.contentIndex)
        if (index === undefined) continue
        this.toolArgumentLengths.set(event.contentIndex, (this.toolArgumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta } }] }, finish_reason: null }] } }
      } else if (event.type === 'toolcall_end') {
        const index = this.toolIndexes.get(event.contentIndex)
        if (index === undefined) continue
        const serialized = JSON.stringify(event.toolCall.arguments)
        if ((this.toolArgumentLengths.get(event.contentIndex) ?? 0) === 0 && serialized !== '{}') {
          yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: serialized } }] }, finish_reason: null }] } }
        }
      } else if (event.type === 'done') {
        if (!this.started) {
          yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] } }
        }
        yield { data: { id: this.id, object: 'chat.completion.chunk', created: this.created, model: `${model.provider}/${model.id}`, choices: [{ index: 0, delta: {}, finish_reason: finishReason(event.reason) }], usage: { prompt_tokens: event.message.usage.input, completion_tokens: event.message.usage.output, total_tokens: event.message.usage.totalTokens } } }
        yield { data: '[DONE]' }
        return
      } else if (event.type === 'error') {
        yield { data: { error: { message: 'The model request failed.', type: 'server_error' } } }
        yield { data: '[DONE]' }
        return
      }
    }
  }
}

export async function* openAiChatEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  model: Model<any>,
): AsyncGenerator<SseEvent> {
  yield* new OpenAiChatStreamAdapter(model).convert(events)
}

/** Owns message/content-block lifecycle state for one Anthropic Messages stream. */
export class AnthropicMessagesStreamAdapter implements GatewayStreamAdapter {
  private messageId = `msg_${crypto.randomUUID()}`
  private readonly opened = new Set<number>()
  private readonly argumentLengths = new Map<number, number>()
  private emittedStart = false

  constructor(
    private readonly model: Model<any>,
    private readonly thinkingDisplay: 'summarized' | 'omitted' = 'summarized',
  ) {}

  private start(partial?: AssistantMessage): SseEvent[] {
    if (this.emittedStart) return []
    this.emittedStart = true
    // Provider response IDs are opaque upstream identifiers, not gateway IDs.
    this.messageId = `msg_${crypto.randomUUID()}`
    return [{ event: 'message_start', data: { type: 'message_start', message: { id: this.messageId, type: 'message', role: 'assistant', model: `${this.model.provider}/${this.model.id}`, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: partial?.usage.input ?? 0, output_tokens: 0 } } } }]
  }

  async *convert(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<SseEvent> {
    const { model, thinkingDisplay } = this
    for await (const event of events) {
      if (event.type === 'start') {
        for (const output of this.start(event.partial)) yield output
      } else if (event.type === 'text_start') {
        for (const output of this.start(event.partial)) yield output
        this.opened.add(event.contentIndex)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' } } }
      } else if (event.type === 'text_delta') {
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'text_delta', text: event.delta } } }
      } else if (event.type === 'text_end') {
        if (!this.opened.has(event.contentIndex)) {
          yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'text', text: '' } } }
        }
        if (event.content) yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'text_delta', text: event.content } } }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
      } else if (event.type === 'thinking_start') {
        for (const output of this.start(event.partial)) yield output
        this.opened.add(event.contentIndex)
        const thinking = event.partial.content[event.contentIndex]
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'thinking', thinking: '', signature: thinking?.type === 'thinking' ? thinking.thinkingSignature ?? '' : '' } } }
      } else if (event.type === 'thinking_delta') {
        if (thinkingDisplay !== 'omitted') {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: event.delta } } }
        }
      } else if (event.type === 'thinking_end') {
        const thinking = event.partial.content[event.contentIndex]
        const signature = thinking?.type === 'thinking' ? thinking.thinkingSignature : undefined
        if (!this.opened.has(event.contentIndex)) {
          yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'thinking', thinking: '', signature: signature ?? '' } } }
        }
        if (thinkingDisplay === 'omitted') {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: '' } } }
        } else if (event.content && !(thinking?.type === 'thinking' && thinking.redacted)) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'thinking_delta', thinking: event.content } } }
        }
        if (signature) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'signature_delta', signature } } }
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
      } else if (event.type === 'toolcall_start') {
        for (const output of this.start(event.partial)) yield output
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'toolCall') continue
        this.opened.add(event.contentIndex)
        yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } } }
      } else if (event.type === 'toolcall_delta') {
        this.argumentLengths.set(event.contentIndex, (this.argumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'input_json_delta', partial_json: event.delta } } }
      } else if (event.type === 'toolcall_end') {
        if (!this.opened.has(event.contentIndex)) yield { event: 'content_block_start', data: { type: 'content_block_start', index: event.contentIndex, content_block: { type: 'tool_use', id: event.toolCall.id, name: event.toolCall.name, input: {} } } }
        if ((this.argumentLengths.get(event.contentIndex) ?? 0) === 0 && Object.keys(event.toolCall.arguments).length > 0) {
          yield { event: 'content_block_delta', data: { type: 'content_block_delta', index: event.contentIndex, delta: { type: 'input_json_delta', partial_json: JSON.stringify(event.toolCall.arguments) } } }
        }
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index: event.contentIndex } }
        this.opened.delete(event.contentIndex)
      } else if (event.type === 'done') {
        for (const index of this.opened) yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } }
        const stopReason = event.reason === 'toolUse' ? 'tool_use' : event.reason === 'length' ? 'max_tokens' : 'end_turn'
        yield { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: event.message.usage.output } } }
        yield { event: 'message_stop', data: { type: 'message_stop' } }
        return
      } else if (event.type === 'error') {
        yield { event: 'error', data: { type: 'error', error: { type: 'api_error', message: 'The model request failed.' } } }
        return
      }
    }
  }
}

export async function* anthropicEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  model: Model<any>,
  thinkingDisplay: 'summarized' | 'omitted' = 'summarized',
): AsyncGenerator<SseEvent> {
  yield* new AnthropicMessagesStreamAdapter(model, thinkingDisplay).convert(events)
}

/** Owns the indexed output-item state for one OpenAI Responses stream. */
export class OpenAiResponsesStreamAdapter implements GatewayStreamAdapter {
  private readonly id = `resp_${crypto.randomUUID()}`
  private readonly createdAt = Math.floor(Date.now() / 1000)
  private readonly output: any[] = []
  private readonly itemIndexes = new Map<number, number>()
  private readonly textIndexes = new Map<number, number>()
  private readonly textParts: string[] = []
  private messageOutputIndex = -1
  private nextOutputIndex = 0
  private nextTextIndex = 0
  private readonly toolArgumentLengths = new Map<number, number>()
  private readonly reasoningIndexes = new Map<number, number>()

  constructor(
    private readonly model: Model<any>,
    private readonly includeReasoningSummary = false,
    private readonly toolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
  ) {}

  private get responseBase() {
    return { id: this.id, object: 'response', created_at: this.createdAt, model: `${this.model.provider}/${this.model.id}` }
  }

  private ensureReasoningItem(contentIndex: number, partial: AssistantMessage): SseEvent[] {
    if (!this.includeReasoningSummary) return []
    const block = partial.content[contentIndex]
    if (block?.type !== 'thinking' || block.redacted || this.reasoningIndexes.has(contentIndex)) return []
    const outputIndex = this.nextOutputIndex++
    this.reasoningIndexes.set(contentIndex, outputIndex)
    this.output[outputIndex] = { type: 'reasoning', id: `rs_${crypto.randomUUID()}`, status: 'in_progress', summary: [{ type: 'summary_text', text: '' }] }
    return [
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: outputIndex, item: this.output[outputIndex] } },
      { event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, part: this.output[outputIndex].summary[0] } },
    ]
  }

  async *convert(events: AsyncIterable<AssistantMessageEvent>): AsyncGenerator<SseEvent> {
    const { model, includeReasoningSummary, toolNamespaces } = this
    const responseBase = this.responseBase
    yield { event: 'response.created', data: { type: 'response.created', response: { ...responseBase, status: 'in_progress', output: [] } } }
    yield { event: 'response.in_progress', data: { type: 'response.in_progress', response: { ...responseBase, status: 'in_progress', output: [] } } }
    for await (const event of events) {
      if (event.type === 'text_start') {
        if (this.messageOutputIndex < 0) {
          this.messageOutputIndex = this.nextOutputIndex++
          this.output.push({ type: 'message', id: `msg_${crypto.randomUUID()}`, status: 'in_progress', role: 'assistant', content: [] })
          yield { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: this.messageOutputIndex, item: this.output[this.messageOutputIndex] } }
        }
        const contentIndex = this.nextTextIndex++
        this.textIndexes.set(event.contentIndex, contentIndex)
        this.textParts[contentIndex] = ''
        const part = { type: 'output_text', text: '', annotations: [], logprobs: [] }
        this.output[this.messageOutputIndex].content[contentIndex] = part
        yield { event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, part } }
      } else if (event.type === 'text_delta') {
        const contentIndex = this.textIndexes.get(event.contentIndex)
        if (contentIndex === undefined || this.messageOutputIndex < 0) continue
        this.textParts[contentIndex] = (this.textParts[contentIndex] ?? '') + event.delta
        yield { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, delta: event.delta, logprobs: [] } }
      } else if (event.type === 'text_end') {
        const contentIndex = this.textIndexes.get(event.contentIndex)
        if (contentIndex === undefined || this.messageOutputIndex < 0) continue
        if (!this.textParts[contentIndex] && event.content) this.textParts[contentIndex] = event.content
        const text = this.textParts[contentIndex] ?? ''
        this.output[this.messageOutputIndex].content[contentIndex].text = text
        yield { event: 'response.output_text.done', data: { type: 'response.output_text.done', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, text, logprobs: [] } }
        yield { event: 'response.content_part.done', data: { type: 'response.content_part.done', item_id: this.output[this.messageOutputIndex].id, output_index: this.messageOutputIndex, content_index: contentIndex, part: this.output[this.messageOutputIndex].content[contentIndex] } }
      } else if (event.type === 'thinking_start') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
      } else if (event.type === 'thinking_delta') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
        const outputIndex = this.reasoningIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        const part = this.output[outputIndex].summary[0]
        part.text += event.delta
        yield { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, delta: event.delta } }
      } else if (event.type === 'thinking_end') {
        for (const frame of this.ensureReasoningItem(event.contentIndex, event.partial)) yield frame
        const outputIndex = this.reasoningIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        const part = this.output[outputIndex].summary[0]
        if (!part.text && event.content) {
          part.text = event.content
          yield { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, delta: event.content } }
        }
        yield { event: 'response.reasoning_summary_text.done', data: { type: 'response.reasoning_summary_text.done', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, text: part.text } }
        yield { event: 'response.reasoning_summary_part.done', data: { type: 'response.reasoning_summary_part.done', item_id: this.output[outputIndex].id, output_index: outputIndex, summary_index: 0, part } }
        this.output[outputIndex].status = 'completed'
        yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'toolcall_start') {
        const call = event.partial.content[event.contentIndex]
        if (call?.type !== 'toolCall') continue
        const outputIndex = this.nextOutputIndex++
        this.itemIndexes.set(event.contentIndex, outputIndex)
        this.output[outputIndex] = { type: 'function_call', id: `fc_${crypto.randomUUID()}`, call_id: call.id, ...responsesToolName(call.name, toolNamespaces), arguments: '', status: 'in_progress' }
        yield { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'toolcall_delta') {
        const outputIndex = this.itemIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        this.output[outputIndex].arguments += event.delta
        this.toolArgumentLengths.set(event.contentIndex, (this.toolArgumentLengths.get(event.contentIndex) ?? 0) + event.delta.length)
        yield { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, delta: event.delta } }
      } else if (event.type === 'toolcall_end') {
        const outputIndex = this.itemIndexes.get(event.contentIndex)
        if (outputIndex === undefined) continue
        if ((this.toolArgumentLengths.get(event.contentIndex) ?? 0) === 0) {
          this.output[outputIndex].arguments = JSON.stringify(event.toolCall.arguments)
          yield { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', item_id: this.output[outputIndex].id, output_index: outputIndex, delta: this.output[outputIndex].arguments } }
        }
        this.output[outputIndex].status = 'completed'
        yield { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', item_id: this.output[outputIndex].id, output_index: outputIndex, arguments: this.output[outputIndex].arguments } }
        yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: outputIndex, item: this.output[outputIndex] } }
      } else if (event.type === 'done') {
        if (this.messageOutputIndex >= 0) {
          this.output[this.messageOutputIndex].status = 'completed'
          yield { event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: this.messageOutputIndex, item: this.output[this.messageOutputIndex] } }
        }
        const completed = serializeResponses(event.message, model, includeReasoningSummary, toolNamespaces)
        completed.id = this.id
        completed.created_at = this.createdAt
        completed.output = this.output
        yield { event: 'response.completed', data: { type: 'response.completed', response: completed } }
        return
      } else if (event.type === 'error') {
        yield { event: 'response.failed', data: { type: 'response.failed', response: { ...responseBase, status: 'failed', error: { code: 'server_error', message: 'The model request failed.' }, output: this.output } } }
        return
      }
    }
  }
}

export async function* responsesEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  model: Model<any>,
  includeReasoningSummary = false,
  toolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): AsyncGenerator<SseEvent> {
  yield* new OpenAiResponsesStreamAdapter(model, includeReasoningSummary, toolNamespaces).convert(events)
}

export async function* protocolEvents(
  dialect: GatewayDialect,
  events: AsyncIterable<AssistantMessageEvent>,
  model: Model<any>,
  anthropicThinkingDisplay?: 'summarized' | 'omitted',
  includeReasoningSummary = false,
  responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>,
): AsyncGenerator<SseEvent> {
  yield* createProtocolStreamAdapter(dialect, model, {
    anthropicThinkingDisplay,
    includeReasoningSummary,
    responsesToolNamespaces,
  }).convert(events)
}

export function createProtocolStreamAdapter(
  dialect: GatewayDialect,
  model: Model<any>,
  options: {
    anthropicThinkingDisplay?: 'summarized' | 'omitted'
    includeReasoningSummary?: boolean
    responsesToolNamespaces?: ReadonlyMap<string, { namespace: string; name: string }>
  } = {},
): GatewayStreamAdapter {
  if (dialect === 'openai-chat') return new OpenAiChatStreamAdapter(model)
  if (dialect === 'anthropic-messages') return new AnthropicMessagesStreamAdapter(model, options.anthropicThinkingDisplay)
  if (dialect === 'openai-responses') {
    return new OpenAiResponsesStreamAdapter(model, options.includeReasoningSummary, options.responsesToolNamespaces)
  }
  throw new Error('Internal RPC does not use public SSE events.')
}

/** Encodes protocol events as SSE frames for one selected public dialect. */
export class SseFrameEncoder {
  private readonly textEncoder = new TextEncoder()

  constructor(private readonly dialect: GatewayDialect) {}

  encode(item: SseEvent): Uint8Array {
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data)
    const prefix = this.dialect === 'anthropic-messages' || this.dialect === 'openai-responses'
      ? `event: ${item.event ?? 'message'}\n`
      : ''
    return this.textEncoder.encode(`${prefix}data: ${data}\n\n`)
  }
}

export function sseChunk(dialect: GatewayDialect, item: SseEvent): Uint8Array {
  return new SseFrameEncoder(dialect).encode(item)
}

export { plainText }
