import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Component } from '@earendil-works/pi-tui'
import type { PermissionBehavior } from '../permissions/types.ts'
import type { AgentSessionPersistence } from '../agent/persistence.ts'

// ============================================================================
// Types
// ============================================================================

/** 工具 UI 组件的公共接口 */
export interface ToolUIComponent extends Component {
  setExpanded(expanded: boolean): void
  getInteractionTargets?(renderedLines: readonly string[]): ToolInteractionTarget[]
  hasToggleButton?(): boolean
  toggleExpanded?(): void
  markExecutionStarted(): void
  updateArgs?(args: Record<string, unknown>): void
  updateElapsed?(elapsedMs: number): void
  updateResult(result: ToolResult, isPartial?: boolean): void
  updateDetails?(details: Record<string, unknown>): void
}

export interface ToolInteractionTarget {
  action: 'toggle-preview'
  rowOffset: number
  startColumn: number
  endColumn: number
  activate: () => void
}

export interface ToolResult {
  content: Array<{ type: string; text?: string }>
  isError: boolean
  details?: Record<string, unknown>
}

/** UI 组件构造器 */
export type ToolUIConstructor = new (toolCallId: string, args: any) => ToolUIComponent

export interface ToolCreationContext {
  getPersistence?: () => AgentSessionPersistence | undefined
}

export interface ToolDisplayContext {
  input: Record<string, unknown>
  details?: Record<string, unknown>
}

export interface ToolSummaryContext {
  input?: Record<string, unknown>
  details?: Record<string, unknown>
  result: ToolResult
  textStats: {
    chars: number
    lines: number
  }
}

export interface ToolDisplayFormatters {
  activity?: (context: ToolDisplayContext) => string | undefined // Short active-turn text shown next to an agent, e.g. "Reading src/app.ts".
  detail?: (context: ToolDisplayContext) => string | undefined // Compact argument text shown after a tool name in the agent tree.
  status?: (context: ToolDisplayContext) => string | undefined // Compact progress/result text shown while a tool is running.
}

export interface ToolAgentDefinition {
  create: (cwd: string, context?: ToolCreationContext) => AgentTool<any, any>
  /** Search/discovery metadata exposed to the Agent, not user-facing copy. */
  description?: string
  schema?: string
  shouldDefer?: boolean
  formatDescription?: (input: Record<string, unknown>) => string
  extractMatchContent?: (input: Record<string, unknown>) => string | undefined
  /** Compact summary used when handing tool results to another Agent. */
  summarizeResult?: (context: ToolSummaryContext) => string | undefined
}

export interface ToolPolicyDefinition {
  defaultPermission: PermissionBehavior
}

export interface ToolPresentationDefinition extends ToolDisplayFormatters {
  View?: ToolUIConstructor
  /** Project streamed input into presentation-only structured details. */
  projectInput?: (cwd: string, input: Record<string, unknown>) => Record<string, unknown> | undefined
  /** Build presentation-only approval preview details for this tool call. */
  prepareApproval?: (
    cwd: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>
}

export interface ToolDefinition {
  name: string
  agent: ToolAgentDefinition
  policy: ToolPolicyDefinition
  presentation: ToolPresentationDefinition
}

export type ToolLifecycleEvent =
  | { phase: 'created'; input: Record<string, unknown> }
  | { phase: 'running' }
  | { phase: 'awaiting-approval' }
  | { phase: 'input'; input: Record<string, unknown> }
  | { phase: 'presentation'; details: Record<string, unknown> }
  | { phase: 'partial'; result: ToolResult }
  | { phase: 'completed'; result: ToolResult }
  | { phase: 'failed'; result: ToolResult }
  | { phase: 'cancelled'; details?: Record<string, unknown> }

/** One compatibility boundary maps generic lifecycle events onto existing tool views. */
export function dispatchToolLifecycle(
  view: ToolUIComponent,
  event: ToolLifecycleEvent,
): void {
  switch (event.phase) {
    case 'created': view.updateArgs?.(event.input); break
    case 'running': view.markExecutionStarted(); break
    case 'awaiting-approval': view.updateDetails?.({ phase: 'approval' }); break
    case 'input': view.updateArgs?.(event.input); break
    case 'presentation': view.updateDetails?.(event.details); break
    case 'partial':
      view.updateResult(event.result, true)
      if (event.result.details) view.updateDetails?.(event.result.details)
      break
    case 'completed':
      view.updateResult(event.result)
      if (event.result.details) view.updateDetails?.(event.result.details)
      break
    case 'failed':
      view.updateResult(event.result)
      if (event.result.details) view.updateDetails?.(event.result.details)
      break
    case 'cancelled': view.updateDetails?.({ ...event.details, phase: 'cancelled' }); break
  }
}

// ============================================================================
// Registry
// ============================================================================

const registry = new Map<string, ToolDefinition>()

export function registerTool(def: ToolDefinition): void {
  registry.set(def.name, def)
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return registry.get(name)
}

export function getAllToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values())
}

export function getToolUIConstructor(name: string): ToolUIConstructor | undefined {
  return registry.get(name)?.presentation.View
}

function formatMcpToolName(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  const parts = name.slice(5).split('__')
  return parts.length === 2 ? `${parts[0]}/${parts[1]}` : name
}

function countTextBlocks(result: ToolResult): { chars: number; lines: number } {
  const text = result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
  return {
    chars: text.length,
    lines: text ? text.split('\n').length : 0,
  }
}

export function formatToolSummary(
  name: string,
  result: ToolResult,
  input?: Record<string, unknown>,
): string {
  const textStats = countTextBlocks(result)
  const details = result.details
  const context: ToolSummaryContext = {
    input,
    details,
    result,
    textStats,
  }
  const definition = registry.get(name)
  const formatted = definition?.agent.summarizeResult?.(context)
  if (formatted) return formatted
  const formattedName = formatMcpToolName(name) ?? name
  const produced = `produced ${textStats.chars.toLocaleString()} chars` +
    (textStats.lines > 0 ? ` across ${textStats.lines.toLocaleString()} lines` : '')
  const status = result.isError ? 'failed' : 'completed'
  return `[${formattedName}] ${status} · ${produced}`
}

export function formatToolActivity(
  name: string,
  input: Record<string, unknown>,
): string {
  const formatted = registry.get(name)?.presentation.activity?.({ input })
  if (formatted) return formatted
  return `Using ${formatMcpToolName(name) ?? name}`
}

export function formatToolDetail(
  name: string,
  input: Record<string, unknown>,
): string {
  const def = registry.get(name)
  const formatted = def?.presentation.detail?.({ input })
  if (formatted) return formatted
  return formatMcpToolName(name) ?? ''
}

export function formatToolStatus(
  name: string,
  input: Record<string, unknown>,
  details?: Record<string, unknown>,
): string | undefined {
  return registry.get(name)?.presentation.status?.({ input, details })
    ?? (details ? undefined : formatMcpToolName(name))
}

export function getToolDefaultPermissions(): Record<string, PermissionBehavior> {
  const result: Record<string, PermissionBehavior> = {}
  for (const [name, def] of registry) {
    result[name] = def.policy.defaultPermission
  }
  return result
}

/** Check if a tool definition should be deferred (hidden from initial context). */
export function isDeferredTool(def: ToolDefinition): boolean {
  return def.agent.shouldDefer === true
}

/** Get tool definitions that should be loaded immediately (not deferred). */
export function getCoreToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).filter(def => !isDeferredTool(def))
}

/** Get tool definitions that are deferred (discovered via ToolSearchTool). */
export function getDeferredToolDefinitions(): ToolDefinition[] {
  return Array.from(registry.values()).filter(isDeferredTool)
}

// ============================================================================
// Dynamic deferred tools (for MCP tools that are created at runtime)
// ============================================================================

const dynamicDeferredTools = new Map<string, ToolDefinition>()

/** Register a dynamically created tool as deferred (e.g., MCP tools). */
export function registerDynamicDeferredTool(def: ToolDefinition): void {
  dynamicDeferredTools.set(def.name, def)
}

/** Remove a dynamically registered deferred tool. */
export function unregisterDynamicDeferredTool(name: string): void {
  dynamicDeferredTools.delete(name)
}

/** Get all deferred tools (registered + dynamic). */
export function getAllDeferredToolDefinitions(): ToolDefinition[] {
  const registered = getDeferredToolDefinitions()
  const dynamic = Array.from(dynamicDeferredTools.values())
  // Deduplicate by name (registered takes precedence)
  const seen = new Set(registered.map(d => d.name))
  return [...registered, ...dynamic.filter(d => !seen.has(d.name))]
}
