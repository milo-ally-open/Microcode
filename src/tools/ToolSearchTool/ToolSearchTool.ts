import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import type { ToolDefinition } from '../registry.ts'

export const TOOL_SEARCH_TOOL_NAME = 'search'

export interface ToolSearchToolOptions {
  /** Get the list of all deferred tool definitions. */
  getDeferredTools: () => ToolDefinition[]
  /** Callback invoked with names of discovered tools. */
  onToolsDiscovered: (names: string[]) => void
}

/**
 * Parse tool name into searchable parts.
 * Handles MCP tools (mcp__server__action) and regular tools (CamelCase).
 */
function parseToolName(name: string): { parts: string[]; full: string; isMcp: boolean } {
  if (name.startsWith('mcp__')) {
    const withoutPrefix = name.replace(/^mcp__/, '').toLowerCase()
    const parts = withoutPrefix.split('__').flatMap(p => p.split('_'))
    return {
      parts: parts.filter(Boolean),
      full: withoutPrefix.replace(/__/g, ' ').replace(/_/g, ' '),
      isMcp: true,
    }
  }

  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  return { parts, full: parts.join(' '), isMcp: false }
}

/** Escape special regex characters. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Keyword-based search over deferred tool names and descriptions. */
function searchTools(
  query: string,
  deferredTools: ToolDefinition[],
  maxResults: number,
): ToolDefinition[] {
  const queryLower = query.toLowerCase().trim()

  // Exact name match
  const exactMatch = deferredTools.find(t => t.name.toLowerCase() === queryLower)
  if (exactMatch) return [exactMatch]

  // MCP prefix match
  if (queryLower.startsWith('mcp__') && queryLower.length > 5) {
    const prefixMatches = deferredTools
      .filter(t => t.name.toLowerCase().startsWith(queryLower))
      .slice(0, maxResults)
    if (prefixMatches.length > 0) return prefixMatches
  }

  // Keyword scoring
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 0)
  const termPatterns = new Map<string, RegExp>()
  for (const term of queryTerms) {
    if (!termPatterns.has(term)) {
      termPatterns.set(term, new RegExp(`\\b${escapeRegExp(term)}\\b`))
    }
  }

  const scored = deferredTools.map(tool => {
    const parsed = parseToolName(tool.name)
    const descLower = (tool.agent.description ?? '').toLowerCase()

    let score = 0
    for (const term of queryTerms) {
      const pattern = termPatterns.get(term)!

      // Name part exact match
      if (parsed.parts.includes(term)) {
        score += parsed.isMcp ? 12 : 10
      } else if (parsed.parts.some(part => part.includes(term))) {
        score += parsed.isMcp ? 6 : 5
      }

      // Full name fallback
      if (parsed.full.includes(term) && score === 0) {
        score += 3
      }

      // Description match
      if (pattern.test(descLower)) {
        score += 2
      }
    }

    return { tool, score }
  })

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(item => item.tool)
}

/** Format a tool definition as a readable schema string for the model. */
function formatToolSchema(def: ToolDefinition): string {
  const lines: string[] = [`## ${def.name}`]
  if (def.agent.description) {
    lines.push(def.agent.description)
  }
  if (def.agent.schema) {
    lines.push(`Parameters: ${def.agent.schema}`)
    return lines.join('\n')
  }
  // Try to extract parameter schema from createTool's output
  // We create a temporary tool instance to read its schema
  try {
    const tempTool = def.agent.create('__schema_probe__')
    if (tempTool.parameters) {
      lines.push(`Parameters: ${JSON.stringify(tempTool.parameters, null, 2)}`)
    }
  } catch {
    // If we can't create a temp instance, just show name + description
  }
  return lines.join('\n')
}

/**
 * Create a ToolSearchTool — a meta-tool that discovers deferred tools.
 *
 * When the model needs a tool that isn't loaded, it calls this tool with
 * a query (keyword or `select:ToolName`). The tool returns the matched
 * tools' schemas and triggers injection into the agent's tool list.
 */
export function createToolSearchTool(options: ToolSearchToolOptions): AgentTool {
  const { getDeferredTools, onToolsDiscovered } = options
  const lastDiscoveredAt = new Map<string, number>()
  const notifyDiscovered = (names: string[]): void => {
    const now = Date.now()
    const fresh = names.filter((name) => {
      const last = lastDiscoveredAt.get(name)
      if (last !== undefined && now - last < 30_000) return false
      lastDiscoveredAt.set(name, now)
      return true
    })
    if (fresh.length > 0) onToolsDiscovered(fresh)
  }

  return {
    name: TOOL_SEARCH_TOOL_NAME,
    label: 'Tool Search',
    description: 'Discover and load deferred tools by name or keyword. Use "select:tool_name" to load a specific tool, or search by keywords. You must call this before using any deferred tool.',
    parameters: Type.Object({
      query: Type.String({
        description: 'Search query. Use "select:tool_name" for direct selection (supports comma-separated: "select:A,B,C"), or keywords to search.',
      }),
      max_results: Type.Optional(Type.Number({
        description: 'Maximum number of results to return (default: 5)',
      })),
    }),
    async execute(
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<any>> {
      const { query, max_results = 5 } = params as { query: string; max_results?: number }
      const deferredTools = getDeferredTools()

      if (deferredTools.length === 0) {
        return {
          content: [{ type: 'text', text: 'No deferred tools available. All tools are already loaded.' }],
          details: { matches: [], query },
        }
      }

      // Check for select: prefix — direct tool selection
      const selectMatch = query.match(/^select:(.+)$/i)
      if (selectMatch) {
        const requested = selectMatch[1]!.split(',').map(s => s.trim()).filter(Boolean)
        const found: ToolDefinition[] = []
        const missing: string[] = []

        for (const toolName of requested) {
          const tool = deferredTools.find(t => t.name.toLowerCase() === toolName.toLowerCase())
          if (tool) {
            if (!found.includes(tool)) found.push(tool)
          } else {
            missing.push(toolName)
          }
        }

        if (found.length === 0) {
          return {
            content: [{ type: 'text', text: `No matching deferred tools found for: ${missing.join(', ')}` }],
            details: { matches: [], query },
          }
        }

        // Trigger tool injection
        notifyDiscovered(found.map(t => t.name))

        const schemas = found.map(formatToolSchema).join('\n\n')
        const missingNote = missing.length > 0 ? `\n\nNote: these tools were not found: ${missing.join(', ')}` : ''
        return {
          content: [{ type: 'text', text: `Discovered ${found.length} tool(s). You can now call them directly.\n\n${schemas}${missingNote}` }],
          details: { matches: found.map(t => t.name), query },
        }
      }

      // Keyword search
      const matches = searchTools(query, deferredTools, max_results)

      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No matching deferred tools found for "${query}". Try different keywords or use "select:tool_name" for exact match.` }],
          details: { matches: [], query },
        }
      }

      // Trigger tool injection
      notifyDiscovered(matches.map(t => t.name))

      const schemas = matches.map(formatToolSchema).join('\n\n')
      return {
        content: [{ type: 'text', text: `Found ${matches.length} tool(s). You can now call them directly.\n\n${schemas}` }],
        details: { matches: matches.map(t => t.name), query },
      }
    },
  }
}
