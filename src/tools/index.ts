import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { Type, type Static, type TSchema } from 'typebox'
import type { McpClientManager } from '../mcp/client.ts'
import type { McpToolInfo } from '../mcp/types.ts'
import type { PermissionBehavior } from '../permissions/types.ts'
import type { Skill } from '../skill.ts'
import { getAllToolDefinitions, getAllDeferredToolDefinitions, getCoreToolDefinitions, getToolDefaultPermissions, registerDynamicDeferredTool, registerTool, type ToolCreationContext } from './registry.ts'
import { joinSummaryParts, producedText, statusPrefix, text } from './summary.ts'
import { TOOL_SEARCH_TOOL_NAME } from './ToolSearchTool/ToolSearchTool.ts'
import { TOOL_NAME as VISION_TOOL_NAME } from './VisionTool/VisionTool.ts'
import { TOOL_NAME as WORKTREE_TOOL_NAME } from './GitWorkTreeTool/GitWorkTreeTool.ts'

const skillSchema = Type.Object({
  skill: Type.String({ description: 'The skill name to execute (e.g., "commit", "review")' }),
  args: Type.Optional(Type.String({ description: 'Optional arguments for the skill' })),
})

export type SkillToolInput = Static<typeof skillSchema>
export const SKILL_TOOL_NAME = 'skill'
const skillDefault: PermissionBehavior = 'allow'
export const SKILL_DEFAULT_PERMISSION = skillDefault

export interface SkillToolDetails {
  skillName: string
  filePath: string
  description: string
  content: string
}

export interface SkillToolOptions {
  getSkills: () => Skill[]
}

export function createSkillToolWithAgent(options: SkillToolOptions): AgentTool<typeof skillSchema, SkillToolDetails> {
  return {
    name: SKILL_TOOL_NAME,
    label: 'Skill',
    description: 'Execute a skill by name. Skills are specialized instructions for specific tasks.',
    parameters: skillSchema,
    async execute(_toolCallId: string, params: SkillToolInput): Promise<AgentToolResult<SkillToolDetails>> {
      const normalizedSkill = params.skill.trim()
      const skills = options.getSkills()
      const skill = skills.find((candidate) => candidate.name === normalizedSkill)
      if (!skill) {
        throw new Error(`Skill "${normalizedSkill}" not found. Available skills: ${skills.map((item) => item.name).join(', ')}`)
      }
      if (skill.disableModelInvocation) {
        throw new Error(`Skill "${normalizedSkill}" cannot be invoked by the model (disable-model-invocation is set)`)
      }
      if (!existsSync(skill.filePath)) throw new Error(`Skill file not found: ${skill.filePath}`)

      const content = await readFile(skill.filePath, 'utf-8')
      return {
        content: [{ type: 'text', text: `Executing skill: ${normalizedSkill}\n\n${content}` }],
        details: { skillName: normalizedSkill, filePath: skill.filePath, description: skill.description, content },
      }
    },
  }
}

export function formatMcpInputSchema(inputSchema: Record<string, any>): string {
  return JSON.stringify(inputSchema, null, 2)
}

function jsonSchemaToTypeBox(inputSchema: Record<string, any>): TSchema {
  if (inputSchema.properties) {
    const properties: Record<string, TSchema> = {}
    const required = Array.isArray(inputSchema.required)
      ? new Set(inputSchema.required.filter((key): key is string => typeof key === 'string'))
      : new Set<string>()

    for (const [key, prop] of Object.entries(inputSchema.properties as Record<string, any>)) {
      let schema: TSchema
      switch (prop.type) {
        case 'string': schema = Type.String({ description: prop.description }); break
        case 'number':
        case 'integer': schema = Type.Number({ description: prop.description }); break
        case 'boolean': schema = Type.Boolean({ description: prop.description }); break
        case 'array': schema = Type.Array(Type.Any(), { description: prop.description }); break
        case 'object': schema = Type.Object({}, { description: prop.description }); break
        default: schema = Type.Any({ description: prop.description })
      }
      properties[key] = required.has(key) ? schema : Type.Optional(schema)
    }
    return Type.Object(properties, { description: inputSchema.description, additionalProperties: true })
  }
  return Type.Object({}, { description: inputSchema.description })
}

export function createMcpTool(clientManager: McpClientManager, toolInfo: McpToolInfo): AgentTool {
  const schema = jsonSchemaToTypeBox(toolInfo.inputSchema)
  return {
    name: `mcp__${toolInfo.serverName}__${toolInfo.name}`,
    label: `MCP: ${toolInfo.name}`,
    description: `[MCP:${toolInfo.serverName}] ${toolInfo.description}`,
    parameters: schema,
    async execute(_toolCallId, params, _signal, onUpdate): Promise<AgentToolResult<any>> {
      onUpdate?.({ content: [{ type: 'text', text: `Calling ${toolInfo.serverName}/${toolInfo.name}...` }], details: {} })
      try {
        const result = await clientManager.callTool(toolInfo.serverName, toolInfo.name, params as Record<string, any>)
        const textContent = result.content?.filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n') ?? ''
        return { content: [{ type: 'text', text: textContent || 'Tool executed successfully' }], details: result }
      } catch (error) {
        throw new Error(`MCP tool error: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

export function createMcpTools(clientManager: McpClientManager): AgentTool[] {
  return clientManager.getAllTools().map((toolInfo) => createMcpTool(clientManager, toolInfo))
}

export function registerMcpToolsAsDeferred(clientManager: McpClientManager): void {
  for (const toolInfo of clientManager.getAllTools()) {
    const toolName = `mcp__${toolInfo.serverName}__${toolInfo.name}`
    registerDynamicDeferredTool({
      name: toolName,
      policy: { defaultPermission: 'ask' },
      agent: {
        create: () => createMcpTool(clientManager, toolInfo),
        description: `[MCP:${toolInfo.serverName}] ${toolInfo.description}`,
        schema: formatMcpInputSchema(toolInfo.inputSchema),
        shouldDefer: true,
      },
      presentation: {},
    })
  }
}

export function createReadMcpResourceTool(clientManager: McpClientManager): AgentTool {
  return {
    name: 'mcp__read_resource',
    label: 'MCP: Read Resource',
    description: 'Read a resource from an MCP server by URI.',
    parameters: Type.Object({
      server: Type.String({ description: 'The MCP server name that provides the resource' }),
      uri: Type.String({ description: 'The resource URI to read' }),
    }),
    async execute(_toolCallId, params): Promise<AgentToolResult<any>> {
      try {
        const args = params as Record<string, any>
        const result = await clientManager.readResource(args.server, args.uri)
        const textContent = result.contents?.map((item) => item.text ?? '').join('\n') ?? ''
        return {
          content: [{ type: 'text', text: textContent || 'Resource read successfully (no text content)' }],
          details: result,
        }
      } catch (error) {
        throw new Error(`MCP resource error: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

export function createListMcpResourcesTool(clientManager: McpClientManager): AgentTool {
  return {
    name: 'mcp__list_resources',
    label: 'MCP: List Resources',
    description: 'List available resources from connected MCP servers. Optionally filter by server name.',
    parameters: Type.Object({ server: Type.Optional(Type.String({ description: 'Optional server name to filter resources by' })) }),
    async execute(_toolCallId, params): Promise<AgentToolResult<any>> {
      const args = params as Record<string, any>
      const resources = clientManager.getAllResources()
      const content = (args.server ? resources.filter((resource) => resource.serverName === args.server) : resources)
        .map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          server: resource.serverName,
          mimeType: resource.mimeType,
          description: resource.description,
        }))
      return {
        content: [{ type: 'text', text: content.length > 0 ? JSON.stringify(content, null, 2) : 'No resources available from connected MCP servers.' }],
        details: content,
      }
    },
  }
}

// Import tool registrations (side effects — each calls registerTool())
import './BashTool/index.ts'
import './FileEditTool/index.ts'
import './FileWriteTool/index.ts'
import './FileReadTool/index.ts'
import './ToolSearchTool/index.ts'
import './AskUserQuestionTool/index.ts'
import './GrepTool/index.ts'
import './GlobTool/index.ts'
import './WebSearchTool/index.ts'
import './WebFetchTool/index.ts'
import './VisionTool/index.ts'
import './TaskTool/index.ts'

// Re-exports for backward compatibility
export { createBashTool, TOOL_DEFAULT_PERMISSION as BASH_DEFAULT_PERMISSION } from './BashTool/BashTool.ts'
export { createFileReadTool, TOOL_DEFAULT_PERMISSION as FILE_READ_DEFAULT_PERMISSION } from './FileReadTool/FileReadTool.ts'
export { createFileWriteTool, TOOL_DEFAULT_PERMISSION as FILE_WRITE_DEFAULT_PERMISSION } from './FileWriteTool/FileWriteTool.ts'
export { createFileEditTool, TOOL_DEFAULT_PERMISSION as FILE_EDIT_DEFAULT_PERMISSION } from './FileEditTool/FileEditTool.ts'
export { createToolSearchTool, TOOL_SEARCH_TOOL_NAME } from './ToolSearchTool/ToolSearchTool.ts'
export type { ToolSearchToolOptions } from './ToolSearchTool/ToolSearchTool.ts'
export { createAskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME } from './AskUserQuestionTool/AskUserQuestionTool.ts'
export { createGrepTool, TOOL_NAME as GREP_TOOL_NAME, TOOL_DEFAULT_PERMISSION as GREP_DEFAULT_PERMISSION } from './GrepTool/GrepTool.ts'
export { createGlobTool, TOOL_NAME as GLOB_TOOL_NAME, TOOL_DEFAULT_PERMISSION as GLOB_DEFAULT_PERMISSION } from './GlobTool/GlobTool.ts'
export { createWebSearchTool, TOOL_NAME as WEB_SEARCH_TOOL_NAME, TOOL_DEFAULT_PERMISSION as WEB_SEARCH_DEFAULT_PERMISSION } from './WebSearchTool/WebSearchTool.ts'
export { createWebFetchTool, TOOL_NAME as WEB_FETCH_TOOL_NAME, TOOL_DEFAULT_PERMISSION as WEB_FETCH_DEFAULT_PERMISSION } from './WebFetchTool/WebFetchTool.ts'
export { createVisionTool, TOOL_NAME as VISION_TOOL_NAME, TOOL_DEFAULT_PERMISSION as VISION_DEFAULT_PERMISSION } from './VisionTool/VisionTool.ts'
export { createTaskTool, TOOL_NAME as TASK_TOOL_NAME, TOOL_DEFAULT_PERMISSION as TASK_DEFAULT_PERMISSION } from './TaskTool/TaskTool.ts'
export { createGitWorkTreeTool, TOOL_NAME as GIT_WORKTREE_TOOL_NAME, TOOL_DEFAULT_PERMISSION as GIT_WORKTREE_DEFAULT_PERMISSION } from './GitWorkTreeTool/GitWorkTreeTool.ts'
/** Get the names of all deferred tool definitions (for system prompt listing). */
export function getDeferredToolNames(): string[] {
  return getAllDeferredToolDefinitions().map(def => def.name)
}

/** Default permission behavior for each built-in tool (tool name → behavior). */
export const TOOL_DEFAULT_PERMISSIONS: Record<string, PermissionBehavior> = {
  ...getToolDefaultPermissions(),
  [SKILL_TOOL_NAME]: skillDefault,
  [WORKTREE_TOOL_NAME]: 'ask',
}

// ============================================================================
// Tool creation
// ============================================================================

export interface CreateCodingToolsOptions {
  cwd: string
  getSkills?: () => any[]
  /** If true, include deferred tools in the output. Default: false. */
  includeDeferred?: boolean
  /** If false, the vision tool is excluded. Default: true. */
  modelSupportsImages?: boolean
  toolContext?: ToolCreationContext
}

export function createCodingTools(options: CreateCodingToolsOptions): AgentTool<any, any>[] {
  const { cwd, getSkills, includeDeferred = false, modelSupportsImages = true, toolContext } = options

  const tools: AgentTool<any, any>[] = []

  // Create tools from registry (excluding skill, which needs special handling)
  const defs = includeDeferred ? getAllToolDefinitions() : getCoreToolDefinitions()
  for (const def of defs) {
    if (def.name === SKILL_TOOL_NAME) continue
    // Skip ToolSearchTool placeholder — it's created separately in agent.ts
    if (def.name === TOOL_SEARCH_TOOL_NAME) continue
    // Skip vision tool if model doesn't support images
    if (def.name === VISION_TOOL_NAME && !modelSupportsImages) continue
    tools.push(def.agent.create(cwd, toolContext))
  }

  // SkillTool needs getSkills at creation time
  if (getSkills) {
    registerTool({
      name: SKILL_TOOL_NAME,
      policy: { defaultPermission: skillDefault },
      agent: {
        create: () => createSkillToolWithAgent({ getSkills }),
        summarizeResult: (context) => {
          const details = context.details ?? {}
          return `[skill] ${statusPrefix(context)}${joinSummaryParts([
            text(details.skillName),
            text(details.filePath),
            producedText(context),
          ])}`
        },
        formatDescription: (input) =>
          typeof input.skill === 'string' ? `skill ${input.skill}` : '(unknown skill)',
        extractMatchContent: (input) =>
          typeof input.skill === 'string' ? input.skill : undefined,
      },
      presentation: {
        status: ({ input }) =>
          typeof input.skill === 'string' ? `Loading: ${input.skill}` : 'Loading skill...',
      },
    })
    tools.push(createSkillToolWithAgent({ getSkills }))
  }

  return tools
}
