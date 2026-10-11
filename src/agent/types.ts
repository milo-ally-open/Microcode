import type {
  AgentEvent,
  AgentMessage,
  StreamFn,
  ThinkingLevel,
} from '@earendil-works/pi-agent-core'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { ModelConfig } from '../models/index.ts'
import type { McpServerState } from '../mcp/types.ts'
import type {
  EffectivePolicy,
  PermissionDecision,
  PermissionMode,
  PermissionSnapshot,
} from '../permissions/index.ts'
import type { CompactionProgress } from '../session/CompactionManager.ts'
import type { AgentTokenSnapshot } from './AgentTokenTracker.ts'
import type { AgentModelSnapshot } from './AgentModelManager.ts'
import type { AgentToolSnapshot } from './AgentToolManager.ts'
import type { AgentSkillSnapshot } from './AgentSkillManager.ts'
import type { AgentSessionPersistence } from './persistence.ts'
import type { ProjectInstructions } from '../instructions/projectInstructions.ts'
import type { Skill } from '../skill.ts'
import type {
  CompactionSettings,
  generateSummary,
} from '@earendil-works/pi-agent-core'

export interface AgentIdentity {
  id: string
  name?: string
  role?: string
}

export type CreateAgentIdentity = Partial<AgentIdentity> & Pick<AgentIdentity, 'id'>

export interface AgentPermissionConfig {
  mode?: PermissionMode
  allow?: string[]
  deny?: string[]
  ask?: string[]
  onPermissionRequest?: (
    toolName: string,
    input: Record<string, unknown>,
    description: string,
  ) => Promise<boolean>
  onAskUserQuestion?: (
    toolName: string,
    input: Record<string, unknown>,
  ) => Promise<{ answers?: Record<string, string>; block?: boolean }>
}

export interface CreateMicrocodeAgentOptions {
  cwd?: string
  projectInstructions?: ProjectInstructions
  modelId?: string
  /** Protocol format (e.g., "anthropic-messages", "openai-completions"). Must match the model ID. */
  api?: Api
  thinkingLevel?: ThinkingLevel
  mcpServers?: McpServerState[]
  onCompactionProgress?: (progress: CompactionProgress) => void
  permission?: AgentPermissionConfig
  skillPaths?: string[]
  pluginSkills?: Skill[]
  pluginDiagnostics?: string[]
  identity?: CreateAgentIdentity
  persistence?: AgentSessionPersistence
  generateSummaryFn?: typeof generateSummary
  compactionSettings?: Partial<CompactionSettings>
  streamFn?: StreamFn
  /** Optional generation client. Defaults to the existing in-process Pi Models collection. */
  models?: Models
  /** Optional transport-owned initial selection and resolver for daemon-backed model catalogs. */
  initialModelConfig?: ModelConfig
  resolveModelConfig?: (modelId: string, api?: Api, provider?: string) => ModelConfig
  resolveModelApiKey?: (model: Model<Api>) => string | undefined
}

export interface CompactAgentOptions {
  instructions?: string
  persistToSession?: boolean
}

export interface AgentCompactionResult {
  readonly summary: string
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly keptMessageCount: number
  readonly messages: readonly AgentMessage[]
  readonly automatic: boolean
}

export interface MicrocodeAgentSnapshot {
  readonly identity: Readonly<AgentIdentity>
  readonly cwd: string
  readonly model: Readonly<Model<Api>>
  readonly modelConfig: Readonly<AgentModelSnapshot>
  readonly thinkingLevel: ThinkingLevel
  readonly systemPrompt: string
  readonly messageCount: number
  readonly toolNames: readonly string[]
  readonly tools: Readonly<AgentToolSnapshot>
  readonly skills: Readonly<AgentSkillSnapshot>
  readonly isStreaming: boolean
  readonly pendingToolCallCount: number
  readonly permission: Readonly<PermissionSnapshot>
  readonly effectivePolicy: Readonly<EffectivePolicy>
  readonly tokens: Readonly<AgentTokenSnapshot>
  readonly errorMessage?: string
}

type WithAgentId<T> = T extends unknown
  ? T & { readonly agentId: string }
  : never

export type MicrocodeAgentCoreEvent = WithAgentId<AgentEvent>

export interface AgentPermissionRequest {
  readonly kind: 'tool' | 'question'
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
  readonly description?: string
}

export type AgentStateChangeReason =
  | 'core_event'
  | 'messages_replaced'
  | 'messages_cleared'
  | 'thinking_changed'
  | 'model_changed'
  | 'permission_changed'
  | 'system_prompt_changed'
  | 'tools_changed'
  | 'skills_changed'
  | 'compaction_completed'

export type MicrocodeAgentEvent =
  | MicrocodeAgentCoreEvent
  | {
      readonly type: 'state_changed'
      readonly agentId: string
      readonly reason: AgentStateChangeReason
      readonly snapshot: Readonly<MicrocodeAgentSnapshot>
    }
  | {
      readonly type: 'token_usage'
      readonly agentId: string
      readonly usage: Readonly<AgentTokenSnapshot>
    }
  | {
      readonly type: 'permission_requested'
      readonly agentId: string
      readonly request: Readonly<AgentPermissionRequest>
    }
  | {
      readonly type: 'permission_resolved'
      readonly agentId: string
      readonly request: Readonly<AgentPermissionRequest>
      readonly allowed: boolean
    }
  | {
      readonly type: 'model_changed'
      readonly agentId: string
      readonly previous: Readonly<Model<Api>>
      readonly current: Readonly<Model<Api>>
    }
  | {
      readonly type: 'tool_started'
      readonly agentId: string
      readonly toolCallId: string
      readonly toolName: string
    }
  | {
      readonly type: 'tool_finished'
      readonly agentId: string
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
    }
  | {
      readonly type: 'compaction_changed'
      readonly agentId: string
      readonly progress: Readonly<CompactionProgress>
    }

export type MicrocodeAgentEventListener = (
  event: MicrocodeAgentEvent,
  signal: AbortSignal,
) => Promise<void> | void

export type MessageUsageResetMode = 'rebuild' | 'preserve'

export type AgentPermissionDecision = PermissionDecision
