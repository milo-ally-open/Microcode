import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, Model } from '@earendil-works/pi-ai'
import { createCodingTools, createToolSearchTool } from '../tools/index.ts'
import {
  createMcpTools,
  createListMcpResourcesTool,
  createReadMcpResourceTool,
  formatMcpInputSchema,
} from '../tools/index.ts'
import {
  getDeferredToolDefinitions,
  type ToolDefinition,
} from '../tools/registry.ts'
import type { Skill } from '../skill.ts'
import type { McpClientManager } from '../mcp/client.ts'
import type { AgentSessionPersistence } from './persistence.ts'
import { assertInitReadPath } from '../instructions/initReadScope.ts'

export interface AgentToolSnapshot {
  readonly names: readonly string[]
  readonly core: readonly string[]
  readonly infrastructure: readonly string[]
  readonly discovered: readonly string[]
  readonly external: readonly string[]
}

type ToolMap = Map<string, AgentTool<any, any>>
const READ_ONLY_PROMPT_TOOL_NAMES = new Set(['read'])

function toToolMap(tools: readonly AgentTool<any, any>[]): ToolMap {
  return new Map(tools.map((tool) => [tool.name, tool]))
}

function freezeNames(tools: ToolMap): readonly string[] {
  return Object.freeze([...tools.keys()])
}

export class AgentToolManager {
  private coreTools: ToolMap
  private readonly infrastructureTools: ToolMap
  private readonly discoveredTools: ToolMap = new Map()
  private readonly externalTools: ToolMap = new Map()
  private readonly pendingDiscovered = new Map<string, AgentTool<any, any>>()
  private readonly deferredDefinitions = new Map<string, ToolDefinition>(
    getDeferredToolDefinitions().map((definition) => [definition.name, definition]),
  )
  private readonly mcpToolNames = new Set<string>()
  private promptToolAllowlist?: ReadonlySet<string>

  constructor(private readonly options: {
    cwd: string
    getSkills: () => readonly Skill[]
    model: Model<Api>
    getPersistence?: () => AgentSessionPersistence | undefined
  }) {
    this.coreTools = toToolMap(this.createCoreTools(options.model))
    const searchTool = createToolSearchTool({
      getDeferredTools: () => [...this.deferredDefinitions.values()],
      onToolsDiscovered: (names) => this.queueDiscoveredTools(names),
    })
    this.infrastructureTools = toToolMap([searchTool])
  }

  previewCoreTools(model: Model<Api>): AgentTool<any, any>[] {
    return this.createCoreTools(model)
  }

  getCoreTools(): AgentTool<any, any>[] {
    return [...this.coreTools.values()]
  }

  replaceCoreTools(tools: readonly AgentTool<any, any>[]): void {
    this.coreTools = toToolMap(tools)
  }

  rebuildCoreTools(model: Model<Api>): void {
    this.replaceCoreTools(this.createCoreTools(model))
  }

  addTools(tools: readonly AgentTool<any, any>[]): void {
    for (const tool of tools) {
      this.externalTools.set(tool.name, tool)
    }
  }

  configureMcpTools(client: McpClientManager): void {
    const mcpTools = client.getAllTools()
    const nextNames = new Set(mcpTools.map((tool) => `mcp__${tool.serverName}__${tool.name}`))
    for (const name of this.mcpToolNames) {
      this.discoveredTools.delete(name)
      this.pendingDiscovered.delete(name)
      if (!nextNames.has(name)) {
        this.deferredDefinitions.delete(name)
        this.externalTools.delete(name)
      }
    }
    const mcpToolSchemas = new Map(
      mcpTools.map((tool) => [
        `mcp__${tool.serverName}__${tool.name}`,
        formatMcpInputSchema(tool.inputSchema),
      ]),
    )
    for (const tool of createMcpTools(client)) {
      if (this.coreTools.has(tool.name) || this.infrastructureTools.has(tool.name)) continue
      this.deferredDefinitions.set(tool.name, {
        name: tool.name,
        policy: { defaultPermission: 'ask' },
        agent: {
          create: () => tool,
          shouldDefer: true,
          description: tool.description,
          schema: mcpToolSchemas.get(tool.name),
        },
        presentation: {},
      })
      this.mcpToolNames.add(tool.name)
    }
    for (const name of this.mcpToolNames) {
      if (!nextNames.has(name)) this.mcpToolNames.delete(name)
    }
    const listResources = createListMcpResourcesTool(client)
    const readResource = createReadMcpResourceTool(client)
    this.externalTools.set(listResources.name, listResources)
    this.externalTools.set(readResource.name, readResource)
  }

  removeTools(names: readonly string[]): void {
    for (const name of names) {
      this.coreTools.delete(name)
      this.infrastructureTools.delete(name)
      this.discoveredTools.delete(name)
      this.externalTools.delete(name)
      this.pendingDiscovered.delete(name)
    }
  }

  findTool(name: string): AgentTool<any, any> | undefined {
    return this.getTools().find((tool) => tool.name === name)
  }

  getTools(): AgentTool<any, any>[] {
    if (this.promptToolAllowlist) {
      return [...this.coreTools.values()]
        .filter((tool) => this.promptToolAllowlist?.has(tool.name))
        .map((tool) => tool.name === 'read' ? {
          ...tool,
          execute: async (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: any) => void) => {
            await assertInitReadPath(this.options.cwd, params.file_path)
            return tool.execute(toolCallId, params, signal, onUpdate)
          },
        } as AgentTool<any, any> : tool)
    }

    const merged = new Map<string, AgentTool<any, any>>()
    for (const collection of [
      this.coreTools,
      this.infrastructureTools,
      this.discoveredTools,
      this.externalTools,
    ]) {
      for (const [name, tool] of collection) {
        merged.set(name, tool)
      }
    }
    const tools = [...merged.values()]
    return tools
  }

  setPromptReadOnly(enabled: boolean): void {
    this.promptToolAllowlist = enabled ? READ_ONLY_PROMPT_TOOL_NAMES : undefined
  }

  commitPendingDiscoveredTools(): AgentTool<any, any>[] {
    if (this.pendingDiscovered.size === 0) return []
    const pending = [...this.pendingDiscovered.values()]
    this.pendingDiscovered.clear()
    for (const tool of pending) {
      this.discoveredTools.set(tool.name, tool)
    }
    return pending
  }

  getSnapshot(): Readonly<AgentToolSnapshot> {
    const allowed = this.promptToolAllowlist
    const visibleCoreTools = allowed
      ? new Map([...this.coreTools].filter(([name]) => allowed.has(name)))
      : this.coreTools
    const emptyTools: ToolMap = new Map()
    return Object.freeze({
      names: Object.freeze(this.getTools().map((tool) => tool.name)),
      core: freezeNames(visibleCoreTools),
      infrastructure: allowed ? freezeNames(emptyTools) : freezeNames(this.infrastructureTools),
      discovered: allowed ? freezeNames(emptyTools) : freezeNames(this.discoveredTools),
      external: allowed ? freezeNames(emptyTools) : freezeNames(this.externalTools),
    })
  }

  private queueDiscoveredTools(names: readonly string[]): void {
    for (const name of names) {
      if (this.discoveredTools.has(name) || this.pendingDiscovered.has(name)) continue
      const definition = this.deferredDefinitions.get(name)
      if (definition) {
        this.pendingDiscovered.set(name, definition.agent.create(this.options.cwd))
      }
    }
  }

  private createCoreTools(model: Model<Api>): AgentTool<any, any>[] {
    return createCodingTools({
      cwd: this.options.cwd,
      getSkills: () => [...this.options.getSkills()],
      modelSupportsImages: model.input.includes('image'),
      toolContext: {
        getPersistence: this.options.getPersistence,
      },
    })
  }
}
