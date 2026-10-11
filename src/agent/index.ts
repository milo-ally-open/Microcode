import { MicrocodeAgent } from './MicrocodeAgent.ts'
import type { CreateMicrocodeAgentOptions } from './types.ts'

export function createMicrocodeAgentRuntime(
  options: CreateMicrocodeAgentOptions = {},
): MicrocodeAgent {
  return new MicrocodeAgent(options)
}

export { MicrocodeAgent, createConvertToLlm } from './MicrocodeAgent.ts'
export type {
  AgentIdentity,
  AgentCompactionResult,
  AgentPermissionConfig,
  AgentPermissionDecision,
  AgentPermissionRequest,
  AgentStateChangeReason,
  CompactAgentOptions,
  CreateAgentIdentity,
  CreateMicrocodeAgentOptions,
  MessageUsageResetMode,
  MicrocodeAgentCoreEvent,
  MicrocodeAgentEvent,
  MicrocodeAgentEventListener,
  MicrocodeAgentSnapshot,
} from './types.ts'
export type {
  AgentTokenSnapshot,
  ApiTokenUsage,
  ContextTokenUsage,
  ModelTokenUsage,
} from './AgentTokenTracker.ts'
export type { AgentModelSnapshot } from './AgentModelManager.ts'
export type { AgentToolSnapshot } from './AgentToolManager.ts'
export type {
  AgentSkillSnapshot,
  LoadedSkillSnapshot,
} from './AgentSkillManager.ts'
export type {
  AgentCompactionRecord,
  AgentSessionPersistence,
} from './persistence.ts'
