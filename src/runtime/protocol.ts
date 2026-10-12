import type { AgentMessage, ThinkingLevel, JsonlSessionMetadata } from '@earendil-works/pi-agent-core'
import type { Api, ImageContent } from '@earendil-works/pi-ai'
import type { PermissionMode } from '../permissions/types.ts'
import type { MicrocodeAgentEvent, MicrocodeAgentSnapshot } from '../agent/types.ts'
import type { McpResourceInfo, McpToolInfo, McpServerStatus } from '../mcp/types.ts'
import type { PluginScope } from '../plugins/types.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import type { CompactAgentOptions, MessageUsageResetMode } from '../agent/types.ts'

export const RUNTIME_PROTOCOL_VERSION = 1 as const

export interface RuntimePluginSnapshot {
  readonly plugins: readonly Readonly<{
    name: string
    version: string
    description: string
    author?: string
    homepage?: string
    repository?: string
    license?: string
    rootDir: string
    scope: 'user' | 'project'
    valid: boolean
    health: 'ready' | 'warning' | 'invalid' | 'incompatible'
    enabled: boolean
    skills: readonly Readonly<{ name: string; description: string }>[]
    servers: readonly Readonly<{ pluginName: string; scope: 'plugin'; sourcePath: string; name: string; qualifiedName: string; transport: string; safeCommandSummary: string }>[]
    diagnostics: readonly string[]
  }>[]
  readonly skills: readonly Readonly<{ name: string; description: string }>[]
  readonly diagnostics: readonly string[]
}

export interface RuntimeMcpServerSnapshot {
  readonly name: string
  readonly status: McpServerStatus
  readonly error?: string
  readonly tools: readonly Readonly<McpToolInfo>[]
  readonly resources: readonly Readonly<McpResourceInfo>[]
  readonly instructions?: string
}

/** Commands accepted by every client adapter. IDs are supplied by clients and echoed in responses. */
export type RuntimeCommand =
  | { readonly type: 'session.begin_draft'; readonly cwd?: string }
  | { readonly type: 'session.ensure_created'; readonly cwd?: string }
  | { readonly type: 'session.select'; readonly sessionId: string }
  | { readonly type: 'session.resume'; readonly sessionId?: string; readonly cwd?: string }
  | { readonly type: 'session.list'; readonly cwd?: string; readonly withTitles?: boolean }
  | { readonly type: 'session.set_title'; readonly sessionId: string; readonly title: string }
  | { readonly type: 'session.list_tasks' }
  | { readonly type: 'session.remind_task'; readonly listId: string; readonly taskId: string; readonly reminder?: boolean }
  | { readonly type: 'agent.prompt'; readonly prompt: string | AgentMessage | readonly AgentMessage[]; readonly images?: readonly ImageContent[] }
  | { readonly type: 'agent.prompt_read_only'; readonly prompt: string }
  | { readonly type: 'agent.cancel' }
  | { readonly type: 'agent.persist' }
  | { readonly type: 'agent.clear_messages' }
  | { readonly type: 'agent.replace_messages'; readonly messages: readonly AgentMessage[]; readonly usageMode?: MessageUsageResetMode }
  | { readonly type: 'agent.compact'; readonly options?: CompactAgentOptions }
  | { readonly type: 'agent.set_thinking_level'; readonly level: ThinkingLevel }
  | { readonly type: 'agent.refresh_system_prompt' }
  | { readonly type: 'model.switch'; readonly modelId: string; readonly api?: Api; readonly provider?: string }
  | { readonly type: 'permission.respond'; readonly requestId: string; readonly decision: 'allow' | 'allow_session' | 'deny'; readonly answers?: Readonly<Record<string, string>>; readonly block?: boolean }
  | { readonly type: 'permission.set_mode'; readonly mode: PermissionMode }
  | { readonly type: 'permission.add_session_rule'; readonly toolName: string; readonly ruleContent?: string }
  | { readonly type: 'permission.request'; readonly toolName: string; readonly input: Readonly<Record<string, unknown>>; readonly description: string }
  | { readonly type: 'skill.load'; readonly name: string }
  | { readonly type: 'skill.unload'; readonly name: string }
  | { readonly type: 'project.instructions.update'; readonly instructions: ProjectInstructions }
  | { readonly type: 'mcp.sync' }
  | { readonly type: 'mcp.remove'; readonly name: string }
  | { readonly type: 'plugin.refresh' }
  | { readonly type: 'plugin.set_enabled_many'; readonly scope: PluginScope; readonly states: Readonly<Record<string, boolean>> }
  | { readonly type: 'runtime.close' }

export interface RuntimeCommandEnvelope {
  /** Omitted only for same-process callers compiled against this runtime package. */
  readonly protocolVersion?: number
  readonly commandId: string
  readonly command: RuntimeCommand
}

export type RuntimeCommandResponse<T = unknown> =
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly commandId: string; readonly ok: true; readonly result: T }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly commandId: string; readonly ok: false; readonly error: { readonly code: RuntimeErrorCode; readonly message: string } }

export type RuntimeErrorCode =
  | 'runtime_closed'
  | 'agent_busy'
  | 'session_not_found'
  | 'session_project_mismatch'
  | 'protocol_version_mismatch'
  | 'command_failed'

export interface RuntimePermissionRequest {
  readonly requestId: string
  readonly sessionId: string | null
  readonly kind: 'tool' | 'question'
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly description?: string
}

export type RuntimeEvent =
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'agent.event'; readonly event: MicrocodeAgentEvent }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'permission.requested'; readonly request: RuntimePermissionRequest }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'permission.resolved'; readonly requestId: string; readonly allowed: boolean; readonly answers?: Readonly<Record<string, string>> }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'session.changed'; readonly session: RuntimeSessionSnapshot }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'prompt.started' }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'prompt.completed'; readonly aborted: boolean }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'mcp.changed'; readonly servers: readonly RuntimeMcpServerSnapshot[] }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'plugins.changed'; readonly plugins: RuntimePluginSnapshot }
  | { readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION; readonly sequence: number; readonly emittedAt: number; readonly sessionId: string | null; readonly type: 'runtime.lifecycle'; readonly state: 'closing' | 'closed' }

export type RuntimeEventInput = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent
    ? Omit<Event, 'protocolVersion' | 'sequence' | 'emittedAt' | 'sessionId'>
    : never
  : never

export interface RuntimeSessionSnapshot {
  readonly id: string | null
  readonly metadata: Readonly<JsonlSessionMetadata> | null
  readonly title?: string
  readonly draft: boolean
}

/** Immutable reconnect snapshot. sequence is the last event included in this view. */
export interface RuntimeSnapshot {
  readonly protocolVersion: typeof RUNTIME_PROTOCOL_VERSION
  readonly sequence: number
  readonly lifecycle: 'ready' | 'closing' | 'closed'
  readonly project: Readonly<{ cwd: string }>
  readonly session: RuntimeSessionSnapshot
  readonly agent: Readonly<MicrocodeAgentSnapshot>
  readonly messages: readonly AgentMessage[]
  readonly mcpServers: readonly RuntimeMcpServerSnapshot[]
  readonly plugins: RuntimePluginSnapshot | null
}

/** Snapshot and event subscription captured together for an adapter's initial sync. */
export interface RuntimeConnection {
  readonly snapshot: RuntimeSnapshot
  readonly unsubscribe: () => void
}

export type RuntimeEventListener = (event: RuntimeEvent) => void

export type RuntimeQuery =
  | { readonly type: 'snapshot' }
  | { readonly type: 'agent.messages' }
  | { readonly type: 'agent.current_model' }
  | { readonly type: 'agent.skills' }
  | { readonly type: 'agent.skill_list' }
  | { readonly type: 'agent.skill_loaded'; readonly name: string }
  | { readonly type: 'agent.project_instructions' }
  | { readonly type: 'agent.is_busy' }
  | { readonly type: 'permission.check'; readonly toolName: string; readonly input: Readonly<Record<string, unknown>> }
  | { readonly type: 'session.metadata' }
  | { readonly type: 'session.id' }
  | { readonly type: 'session.title'; readonly sessionId: string }
  | { readonly type: 'sessions.list_tasks' }
  | { readonly type: 'mcp.servers' }
  | { readonly type: 'plugins.snapshot' }
  | { readonly type: 'plugins.list' }
