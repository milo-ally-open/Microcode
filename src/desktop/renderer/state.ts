import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { RuntimeEvent } from '../../runtime/protocol.ts'
import type { DesktopBackendSnapshot } from '../protocol.ts'

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function messageIdentity(message: AgentMessage): string {
  const value = object(message)
  const id = value?.id
  const timestamp = value?.timestamp
  return `${String(value?.role ?? '')}:${String(id ?? timestamp ?? '')}`
}

function replaceMessage(messages: readonly AgentMessage[], incoming: AgentMessage): readonly AgentMessage[] {
  const identity = messageIdentity(incoming)
  const index = messages.findIndex((message) => messageIdentity(message) === identity)
  if (index < 0) return Object.freeze([...messages, incoming])
  const next = [...messages]
  next[index] = incoming
  return Object.freeze(next)
}

/** Applies a single ordered runtime event; gaps ask the caller to reload a full snapshot. */
export function applyRuntimeEvent(
  current: DesktopBackendSnapshot,
  event: RuntimeEvent,
): { readonly snapshot: DesktopBackendSnapshot; readonly sequenceGap: boolean } {
  const runtime = current.runtime
  if (!runtime || event.sequence <= runtime.sequence) return { snapshot: current, sequenceGap: false }
  if (event.sequence !== runtime.sequence + 1) return { snapshot: current, sequenceGap: true }

  let nextRuntime = { ...runtime, sequence: event.sequence }
  let nextPermissions = current.pendingPermissions
  if (event.type === 'session.changed') nextRuntime = { ...nextRuntime, session: event.session }
  if (event.type === 'agent.event') {
    const agentEvent = object(event.event)
    const message = object(agentEvent?.message)
    if ((agentEvent?.type === 'message_start' || agentEvent?.type === 'message_update' || agentEvent?.type === 'message_end') && message) {
      nextRuntime = { ...nextRuntime, messages: replaceMessage(runtime.messages, message as unknown as AgentMessage) }
    } else if (agentEvent?.type === 'state_changed' && agentEvent.reason !== 'model_changed' && object(agentEvent.snapshot)) {
      // The desktop model picker waits for the switch command response before
      // publishing the returned runtime snapshot as the selected model.
      nextRuntime = { ...nextRuntime, agent: agentEvent.snapshot as typeof runtime.agent }
    } else if (agentEvent?.type === 'token_usage' && object(agentEvent.usage)) {
      nextRuntime = { ...nextRuntime, agent: { ...runtime.agent, tokens: agentEvent.usage as typeof runtime.agent.tokens } }
    } else if (agentEvent?.type === 'messages_replaced' || agentEvent?.type === 'messages_cleared') {
      nextRuntime = { ...nextRuntime, messages: Object.freeze([]) }
    }
  }
  if (event.type === 'permission.requested') {
    nextPermissions = Object.freeze([...current.pendingPermissions.filter((item) => item.requestId !== event.request.requestId), event.request])
  } else if (event.type === 'permission.resolved') {
    nextPermissions = Object.freeze(current.pendingPermissions.filter((item) => item.requestId !== event.requestId))
  }
  if (event.type === 'mcp.changed') nextRuntime = { ...nextRuntime, mcpServers: event.servers }
  if (event.type === 'plugins.changed') nextRuntime = { ...nextRuntime, plugins: event.plugins }
  if (event.type === 'runtime.lifecycle') nextRuntime = { ...nextRuntime, lifecycle: event.state }

  return {
    snapshot: Object.freeze({ ...current, runtime: Object.freeze(nextRuntime), pendingPermissions: nextPermissions }),
    sequenceGap: false,
  }
}

export function messageText(message: AgentMessage): string {
  const value = object(message)
  const content = value?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part) => {
    const item = object(part)
    return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
  }).join('')
}
